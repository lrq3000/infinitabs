"""Package committed extension files for Chrome's Load unpacked installation, without signing keys."""

import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import zipfile


class ReleasePackager:
    """Read Git blobs in one batch so packaging is linear in the source size and ignores local edits."""

    TAG = re.compile(r'v?(?P<base>(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))(?P<pre>-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?')

    def __init__(self, repository: Path, tag: str):
        self.repository = Path(repository)
        self.tag = tag
        match = self.TAG.fullmatch(tag)
        if not match:
            raise ValueError('Release tag must be a SemVer version with an optional leading v')
        self.version = match['base']
        numbers = [int(part) for part in self.version.split('.')]
        if max(numbers) > 65535 or not any(numbers):
            raise ValueError('Release version is outside Chrome manifest version limits')
        if match['pre'] and any(part.isdigit() and len(part) > 1 and part.startswith('0') for part in match['pre'][1:].split('.')):
            raise ValueError('Numeric SemVer prerelease identifiers cannot have leading zeroes')

    def _git(self, *args, input=None):
        try:
            return subprocess.run(['git', '-C', str(self.repository), *args], input=input, check=True,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
        except subprocess.CalledProcessError as error:
            raise ValueError('Cannot read committed release input: ' + error.stderr.decode(errors='replace').strip()) from error

    @staticmethod
    def safe_path(name):
        # ZIP entry names must be portable to Windows as well as Unix; never extract/link outside the extension.
        if not isinstance(name, str) or not name or '\\' in name or ':' in name or '\0' in name or any(part in {'', '.', '..'} for part in name.split('/')):
            raise ValueError(f'Unsafe extension path: {name!r}')
        return name

    def _committed_files(self):
        entries = []
        tree = self._git('ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', 'src', 'LICENSE', 'package.json', 'package-lock.json')
        for entry in tree.split(b'\0'):
            if not entry:
                continue
            metadata, path = entry.split(b'\t', 1)
            mode, kind, object_id = metadata.split()
            name = self.safe_path(path.decode('utf-8'))
            if mode not in {b'100644', b'100755'} or kind != b'blob':
                raise ValueError(f'Release input must be a regular Git file, not a symlink/submodule: {name}')
            entries.append((name, object_id))
        # cat-file avoids export-ignore/export-subst attributes altering or omitting committed source bytes.
        stream = io.BytesIO(self._git('cat-file', '--batch', input=b''.join(object_id + b'\n' for _, object_id in entries)))
        files = {}
        for name, object_id in entries:
            actual_id, kind, size = stream.readline().split()
            if actual_id != object_id or kind != b'blob':
                raise ValueError(f'Unexpected Git object for {name}')
            files[name] = stream.read(int(size))
            if stream.read(1) != b'\n':
                raise ValueError(f'Incomplete Git object for {name}')
        return files

    @staticmethod
    def _json(files, name):
        try:
            value = json.loads(files[name])
            if not isinstance(value, dict):
                raise ValueError('expected an object')
            return value
        except (KeyError, ValueError, UnicodeError) as error:
            raise ValueError(f'Missing or invalid committed {name}') from error

    def _extension_files(self, files):
        package = self._json(files, 'package.json')
        lock = self._json(files, 'package-lock.json')
        manifest = self._json(files, 'src/manifest.json')
        packages = lock.get('packages')
        locked_root = packages.get('') if isinstance(packages, dict) else None
        versions = [package.get('version'), lock.get('version'), manifest.get('version'),
                    locked_root.get('version') if isinstance(locked_root, dict) else None]
        if any(version != self.version for version in versions):
            raise ValueError('Release tag, manifest, package, and lockfile versions must agree')
        name = package.get('name')
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', name):
            raise ValueError('Package name must be a safe unscoped filename prefix')
        if not files.get('LICENSE', b'').strip():
            raise ValueError('Committed MIT LICENSE is missing or empty')
        extension = {}
        for path, content in files.items():
            if not path.startswith('src/'):
                continue
            local = self.safe_path(path[4:])
            if PurePosixPath(local).suffix.lower() in {'.pem', '.key', '.crx'} or {'.git', 'node_modules'} & set(local.split('/')):
                raise ValueError(f'Private key or development artifact cannot be distributed: {local}')
            extension[local] = content
        if 'LICENSE' in extension and extension['LICENSE'] != files['LICENSE']:
            raise ValueError('src/LICENSE conflicts with the root MIT LICENSE')
        extension['LICENSE'] = files['LICENSE']
        for section, key in [('background', 'service_worker'), ('side_panel', 'default_path'),
                             ('options_ui', 'page'), ('action', 'default_popup')]:
            value = manifest.get(section, {})
            if not isinstance(value, dict):
                raise ValueError(f'Invalid manifest section: {section}')
            if key in value and self.safe_path(value[key]) not in extension:
                raise ValueError(f'Missing manifest resource: {value[key]}')
        self.filename = f'{name}_v{self.tag.removeprefix("v")}.zip'
        return extension

    @staticmethod
    def verify(archive, expected=None):
        """Validate bytes before considering the ZIP usable or replacing a public asset."""
        try:
            with zipfile.ZipFile(archive) as zipped:
                names = zipped.namelist()
                if len(names) != len(set(names)) or zipped.testzip() is not None:
                    raise ValueError('ZIP contains duplicate or corrupt entries')
                for name in names:
                    ReleasePackager.safe_path(name)
                if 'manifest.json' not in names or not zipped.read('LICENSE').strip():
                    raise ValueError('ZIP must contain manifest.json and MIT LICENSE at root')
                if expected is not None and {name: zipped.read(name) for name in names} != expected:
                    raise ValueError('ZIP does not match the committed source and MIT LICENSE')
        except (zipfile.BadZipFile, KeyError) as error:
            raise ValueError('Invalid release ZIP or missing MIT LICENSE') from error

    def build(self, output_dir: Path) -> Path:
        files = self._extension_files(self._committed_files())
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        archive = output_dir / self.filename
        with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zipped:
            # Fixed timestamps, ordering, and permissions make local builds and Action reruns reproducible.
            for name in sorted(files):
                entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = 0o100644 << 16
                entry.compress_type = zipfile.ZIP_DEFLATED
                zipped.writestr(entry, files[name], compresslevel=9)
        self.verify(archive, files)
        return archive
