"""Package committed extension files for Chrome's Load unpacked installation, without signing keys."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
from urllib import error as urlerror, parse, request
import unicodedata
import zipfile


class ReleasePackager:
    """Read Git blobs in one batch so packaging is linear in the source size and ignores local edits."""

    TAG = re.compile(r'v?(?P<base>(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))(?P<pre>-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?')
    MIT_NOTICES = (
        'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
        'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.',
        'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
    )

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
        for part in name.split('/'):
            if part.endswith((' ', '.')) or any(ord(char) < 32 or char in '<>"|?*' for char in part):
                raise ValueError(f'Nonportable extension path: {name!r}')
            if re.fullmatch(r'(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])', part.split('.')[0], re.IGNORECASE):
                raise ValueError(f'Windows-reserved extension path: {name!r}')
        return name

    @staticmethod
    def _validate_paths(names):
        # A trie catches file/directory conflicts and case/Unicode aliases in linear path-component work.
        # Validate after injecting LICENSE: a source file named License or LICENSE/child must never replace the notice on extraction.
        root = {}
        for name in names:
            node = root
            for part in ReleasePackager.safe_path(name).split('/'):
                if None in node:
                    raise ValueError(f'File/directory conflict in release ZIP: {name}')
                node = node.setdefault(unicodedata.normalize('NFC', part).casefold(), {})
            if node:
                raise ValueError(f'Conflicting or aliased release ZIP path: {name}')
            node[None] = name

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

    @staticmethod
    def _validate_license(content):
        # Tolerate line-ending/wrapping changes, but never distribute an empty/truncated or unrelated notice as MIT.
        text = content.decode('utf-8-sig')
        normalized = ' '.join(text.casefold().split())
        if not re.search(r'(?im)^copyright\s+(?:\(c\)\s+)?\S[^\r\n]*', text) or any(' '.join(notice.casefold().split()) not in normalized for notice in ReleasePackager.MIT_NOTICES):
            raise ValueError('MIT LICENSE must retain its copyright, permission, inclusion, and warranty notices')

    @staticmethod
    def _validate_manifest(manifest):
        if not isinstance(manifest, dict) or type(manifest.get('manifest_version')) is not int or manifest['manifest_version'] != 3:
            raise ValueError('Extension manifest_version must be the integer 3')
        if not isinstance(manifest.get('name'), str) or not manifest['name'].strip():
            raise ValueError('Extension manifest must have a nonempty name')

    def _extension_files(self, files):
        package = self._json(files, 'package.json')
        lock = self._json(files, 'package-lock.json')
        manifest = self._json(files, 'src/manifest.json')
        self._validate_manifest(manifest)
        packages = lock.get('packages')
        locked_root = packages.get('') if isinstance(packages, dict) else None
        versions = [package.get('version'), lock.get('version'), manifest.get('version'),
                    locked_root.get('version') if isinstance(locked_root, dict) else None]
        if any(version != self.version for version in versions):
            raise ValueError('Release tag, manifest, package, and lockfile versions must agree')
        name = package.get('name')
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', name):
            raise ValueError('Package name must be a safe unscoped filename prefix')
        self._validate_license(files.get('LICENSE', b''))
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
        self._validate_paths(extension)
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
                ReleasePackager._validate_paths(names)
                if 'manifest.json' not in names or not zipped.read('LICENSE').strip():
                    raise ValueError('ZIP must contain manifest.json and MIT LICENSE at root')
                ReleasePackager._validate_license(zipped.read('LICENSE'))
                ReleasePackager._validate_manifest(json.loads(zipped.read('manifest.json')))
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


class ReleaseAssetUploader:
    """Replace only the named ZIP on the event's release ID; never resolve a recreated release by tag."""

    def __init__(self, repository: str, token: str):
        if not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]*/[A-Za-z0-9_-][A-Za-z0-9_.-]*', repository):
            raise ValueError('GITHUB_REPOSITORY must be an owner/repository name')
        if not token:
            raise ValueError('GITHUB_TOKEN is required to upload a release asset')
        self.repository = repository
        self.token = token

    def _request(self, method, endpoint, data=None, upload=False):
        host = 'https://uploads.github.com' if upload else 'https://api.github.com'
        headers = {'Authorization': f'Bearer {self.token}', 'Accept': 'application/vnd.github+json',
                   'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'InfiniTabs-release-packager'}
        if upload:
            headers['Content-Type'] = 'application/zip'
        operation = request.Request(host + '/repos/' + self.repository + '/' + endpoint,
                                    data=data, headers=headers, method=method)
        with request.urlopen(operation, timeout=60) as response:
            body = response.read()
            return json.loads(body) if body else None

    def upload(self, archive: Path, tag: str, release_id: int) -> dict:
        if type(release_id) is not int or release_id <= 0:
            raise ValueError('Release ID must be a positive integer')
        archive = Path(archive)
        data = archive.read_bytes()
        # Validate the exact bytes about to be uploaded before deleting any existing public asset.
        ReleasePackager.verify(io.BytesIO(data))
        digest = 'sha256:' + hashlib.sha256(data).hexdigest()
        endpoint = f'releases/{release_id}'
        release = self._request('GET', endpoint)
        if release.get('id') != release_id or release.get('tag_name') != tag:
            raise ValueError('Release ID/tag does not match the triggering event')
        if release.get('draft') is not False or release.get('immutable') is not False:
            raise ValueError('Post-publication upload requires a published, mutable release')
        matches = []
        page = 1
        while True:
            assets = self._request('GET', f'{endpoint}/assets?per_page=100&page={page}')
            matches.extend(asset for asset in assets if asset['name'] == archive.name)
            if len(assets) < 100:
                break
            page += 1
        for asset in matches:
            if type(asset['id']) is not int or asset['id'] <= 0:
                raise ValueError('Invalid existing release asset ID')
        # The maintainer explicitly requires unconditional replacement, even if GitHub reports the same digest.
        # Deletion and upload are not transactional: a failed upload leaves this ZIP absent until a rerun.
        for asset in matches:
            self._request('DELETE', f'releases/assets/{asset["id"]}')
        uploaded = self._request('POST', endpoint + '/assets?' + parse.urlencode({'name': archive.name}),
                                 data=data, upload=True)
        if uploaded.get('name') != archive.name or uploaded.get('size') != len(data) or uploaded.get('state') != 'uploaded':
            raise ValueError('GitHub did not confirm the expected uploaded ZIP')
        if uploaded.get('digest') != digest:
            raise ValueError('Uploaded ZIP SHA-256 digest does not match the local archive')
        return uploaded


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag', required=True, help='Release tag matching the committed project version')
    parser.add_argument('--output-dir', type=Path, default=Path('dist'))
    parser.add_argument('--release-id', type=int, help='Upload to this published event release ID, replacing the same-name asset')
    args = parser.parse_args()
    try:
        archive = ReleasePackager(Path.cwd(), args.tag).build(args.output_dir)
        print(archive)
        if args.release_id is not None:
            uploader = ReleaseAssetUploader(os.environ.get('GITHUB_REPOSITORY', ''), os.environ.get('GITHUB_TOKEN', ''))
            uploaded = uploader.upload(archive, args.tag, args.release_id)
            print('Uploaded and verified: ' + uploaded['browser_download_url'])
    except (ValueError, OSError, urlerror.URLError) as error:
        parser.exit(1, f'Release packaging failed: {error}\n')


if __name__ == '__main__':
    main()
