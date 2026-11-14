"""Exercise release packaging against real, isolated Git repositories, never a published release."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'package_release.py'


class ReleasePackageTest(unittest.TestCase):
    def setUp(self):
        # Retain fixtures for diagnosis instead of deleting files behind the operator's back.
        parent = Path(tempfile.gettempdir()) / 'opencode'
        parent.mkdir(exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix='release-package-', dir=parent))
        self.git('init', '--quiet')
        self.git('config', 'core.autocrlf', 'false')
        self.package = {'name': 'sample-tabs', 'version': '1.2.3'}
        self.manifest = {'manifest_version': 3, 'name': 'Sample Tabs', 'version': '1.2.3',
                         'background': {'service_worker': 'background.js'},
                         'side_panel': {'default_path': 'sidebar.html'}}
        self.lock = {'name': 'sample-tabs', 'version': '1.2.3', 'lockfileVersion': 3,
                     'packages': {'': {'name': 'sample-tabs', 'version': '1.2.3'}}}
        self.write_json('package.json', self.package)
        self.write_json('package-lock.json', self.lock)
        self.write_json('src/manifest.json', self.manifest)
        self.write('src/background.js', b'// committed worker\n')
        self.write('src/sidebar.html', b'<!doctype html><title>Fixture</title>\n')
        self.write('src/nested/icon.bin', bytes(range(256)))
        self.write('LICENSE', b'MIT License\nCopyright fixture\nPermission is hereby granted, free of charge.\n')
        self.commit()

    def git(self, *args, input=None):
        return subprocess.run(['git', '-C', str(self.root), *args], input=input, check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def write_json(self, name, content):
        self.write(name, json.dumps(content).encode())

    def commit(self):
        self.git('add', '--all')
        self.git('-c', 'user.name=Release Tests', '-c', 'user.email=release-tests@example.invalid',
                 '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'fixture')

    def packager(self, tag='v1.2.3'):
        self.assertTrue(SCRIPT.exists(), 'Release packager has not been implemented')
        spec = importlib.util.spec_from_file_location('package_release', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.ReleasePackager(self.root, tag)

    def build(self, tag='v1.2.3'):
        return self.packager(tag).build(self.root / 'dist')

    def test_zip_is_unpacked_installable_and_preserves_committed_bytes_and_license(self):
        archive = self.build()
        self.assertEqual(archive.name, 'sample-tabs_v1.2.3.zip')
        with zipfile.ZipFile(archive) as zipped:
            self.assertEqual(set(zipped.namelist()), {'manifest.json', 'background.js', 'sidebar.html', 'nested/icon.bin', 'LICENSE'})
            self.assertEqual(zipped.read('nested/icon.bin'), bytes(range(256)))
            self.assertEqual(zipped.read('LICENSE'), self.git('show', 'HEAD:LICENSE'))
            self.assertEqual(json.loads(zipped.read('manifest.json'))['version'], self.manifest['version'])
            self.assertIsNone(zipped.testzip())

    def test_local_edits_untracked_files_and_old_distributions_are_not_packaged(self):
        self.write('src/background.js', b'// uncommitted edit\n')
        self.write('src/private.pem', b'not for distribution')
        self.write('dist/old.zip', b'old output')
        with zipfile.ZipFile(self.build()) as zipped:
            self.assertEqual(zipped.read('background.js'), b'// committed worker\n')
            self.assertNotIn('private.pem', zipped.namelist())
            self.assertNotIn('old.zip', zipped.namelist())

    def test_output_is_deterministic_and_replaces_corrupt_local_zip(self):
        archive = self.build()
        original = archive.read_bytes()
        archive.write_bytes(b'corrupt previous archive')
        self.assertEqual(self.build().read_bytes(), original)

    def test_optional_v_and_semver_suffixes_are_reflected_in_filename(self):
        for tag, expected in [('1.2.3', 'sample-tabs_v1.2.3.zip'),
                              ('v1.2.3-beta.1', 'sample-tabs_v1.2.3-beta.1.zip'),
                              ('v1.2.3+build.7', 'sample-tabs_v1.2.3+build.7.zip')]:
            with self.subTest(tag=tag):
                self.assertEqual(self.build(tag).name, expected)

    def test_malformed_or_mismatched_release_tag_is_rejected(self):
        for tag in ['v2.0.0', 'v1.2', '../1.2.3', 'v01.2.3', 'v1.2.3-', 'v1.2.3-a..b', 'v1.2.3-01', 'v1.2.3\n']:
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                self.build(tag)

    def test_all_version_sources_must_agree(self):
        for name, value in [('package.json', {**self.package, 'version': '1.2.4'}),
                            ('package-lock.json', {**self.lock, 'version': '1.2.4'}),
                            ('package-lock.json', {**self.lock, 'packages': {'': {'version': '1.2.4'}}}),
                            ('src/manifest.json', {**self.manifest, 'version': '1.2.4'})]:
            with self.subTest(name=name, value=value):
                self.write_json('package.json', self.package)
                self.write_json('package-lock.json', self.lock)
                self.write_json('src/manifest.json', self.manifest)
                self.write_json(name, value)
                self.commit()
                with self.assertRaises(ValueError):
                    self.build()

    def test_unsafe_package_names_are_rejected(self):
        for name in ['../outside', '@scope/name', '', '.', '..', 'name with spaces', 'name\n']:
            with self.subTest(name=name):
                self.write_json('package.json', {**self.package, 'name': name})
                self.commit()
                with self.assertRaises(ValueError):
                    self.build()

    def test_missing_or_empty_license_is_rejected(self):
        self.git('rm', '--quiet', 'LICENSE')
        self.commit()
        with self.assertRaisesRegex(ValueError, 'LICENSE'):
            self.build()
        self.write('LICENSE', b'')
        self.commit()
        with self.assertRaisesRegex(ValueError, 'LICENSE'):
            self.build()

    def test_missing_or_unsafe_manifest_entrypoint_is_rejected(self):
        for path in ['missing.js', '../outside.js', '/background.js', 'C:/outside.js', 'nested\\outside.js']:
            with self.subTest(path=path):
                manifest = {**self.manifest, 'background': {'service_worker': path}}
                self.write_json('src/manifest.json', manifest)
                self.commit()
                with self.assertRaises(ValueError):
                    self.build()

    def test_committed_signing_key_is_rejected(self):
        self.write('src/signing.pem', b'private fixture')
        self.commit()
        with self.assertRaises(ValueError):
            self.build()

    def test_git_symlink_is_rejected_without_requiring_windows_symlink_permissions(self):
        blob = self.git('hash-object', '-w', '--stdin', input=b'../../outside').decode().strip()
        self.git('update-index', '--add', '--cacheinfo', f'120000,{blob},src/escape')
        self.git('-c', 'user.name=Release Tests', '-c', 'user.email=release-tests@example.invalid',
                 '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'symlink fixture')
        with self.assertRaises(ValueError):
            self.build()


if __name__ == '__main__':
    unittest.main()
