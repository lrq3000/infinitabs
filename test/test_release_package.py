"""Exercise release packaging against real, isolated Git repositories, never a published release."""

import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'package_release.py'


class ReleaseFixture(unittest.TestCase):
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

    def module(self):
        self.assertTrue(SCRIPT.exists(), 'Release packager has not been implemented')
        spec = importlib.util.spec_from_file_location('package_release', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def packager(self, tag='v1.2.3'):
        return self.module().ReleasePackager(self.root, tag)

    def build(self, tag='v1.2.3'):
        return self.packager(tag).build(self.root / 'dist')


class ReleasePackageTest(ReleaseFixture):
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


class ReleaseUploadTest(ReleaseFixture):
    def setUp(self):
        super().setUp()
        self.archive = self.build()
        self.release = {'id': 42, 'tag_name': 'v1.2.3', 'draft': False, 'prerelease': False, 'immutable': False}
        self.other = {'id': 7, 'name': 'other-asset.txt', 'state': 'uploaded', 'size': 12}
        self.assets = [dict(self.other)]
        self.requests = []
        self.upload_error = None
        self.bad_digest = False

    def uploader(self, repository='owner/tabs', token='fixture-token'):
        module = self.module()
        self.assertTrue(hasattr(module, 'ReleaseAssetUploader'), 'Release uploader has not been implemented')
        return module.ReleaseAssetUploader(repository, token)

    def respond(self, req, timeout):
        # Mock only the HTTP boundary. Production request construction, pagination, ZIP checks, and replacement decisions remain real.
        self.requests.append(req)
        self.assertEqual(req.get_header('Authorization'), 'Bearer fixture-token')
        self.assertGreater(timeout, 0)
        parsed = urlsplit(req.full_url)
        prefix = '/repos/owner/tabs/releases/'
        self.assertIn(parsed.netloc, {'api.github.com', 'uploads.github.com'})
        if req.method == 'GET' and parsed.netloc == 'api.github.com' and parsed.path == prefix + '42':
            result = self.release
        elif req.method == 'GET' and parsed.path == prefix + '42/assets':
            query = parse_qs(parsed.query)
            self.assertEqual(query['per_page'], ['100'])
            page = int(query['page'][0])
            result = self.assets[(page - 1) * 100:page * 100]
        elif req.method == 'DELETE' and parsed.netloc == 'api.github.com' and parsed.path.startswith(prefix + 'assets/'):
            asset_id = int(parsed.path.rsplit('/', 1)[1])
            self.assertIn(asset_id, [asset['id'] for asset in self.assets])
            self.assets = [asset for asset in self.assets if asset['id'] != asset_id]
            return io.BytesIO(b'')
        elif req.method == 'POST' and parsed.netloc == 'uploads.github.com' and parsed.path == prefix + '42/assets':
            if self.upload_error:
                raise self.upload_error
            name = parse_qs(parsed.query)['name'][0]
            self.assertEqual(req.get_header('Content-type'), 'application/zip')
            self.assertEqual(req.data, self.archive.read_bytes())
            result = {'id': 99, 'name': name, 'size': len(req.data), 'state': 'uploaded',
                      'digest': 'sha256:' + ('0' * 64 if self.bad_digest else hashlib.sha256(req.data).hexdigest()),
                      'browser_download_url': 'https://example.invalid/' + name}
            self.assets.append(result)
        else:
            self.fail(f'Unexpected HTTP operation: {req.method} {req.full_url}')
        return io.BytesIO(json.dumps(result).encode())

    def upload(self):
        with patch('urllib.request.urlopen', side_effect=self.respond):
            return self.uploader().upload(self.archive, 'v1.2.3', 42)

    def test_uploads_new_zip_to_event_release_id_and_preserves_other_assets(self):
        result = self.upload()
        self.assertEqual(result['name'], 'sample-tabs_v1.2.3.zip')
        self.assertEqual([asset['id'] for asset in self.assets], [7, 99])
        self.assertEqual(self.assets[0], self.other)

    def test_existing_same_name_zip_is_always_replaced_even_if_digest_matches(self):
        for digest in ['sha256:corrupt', 'sha256:' + hashlib.sha256(self.archive.read_bytes()).hexdigest()]:
            with self.subTest(digest=digest):
                self.assets = [dict(self.other), {'id': 8, 'name': self.archive.name, 'digest': digest}]
                self.upload()
                self.assertEqual([asset['id'] for asset in self.assets], [7, 99])
                self.assertEqual(self.assets[0], self.other)

    def test_existing_asset_on_later_page_is_replaced_without_deleting_other_assets(self):
        others = [{'id': i + 100, 'name': f'other-{i}.txt'} for i in range(100)]
        self.assets = others + [{'id': 8, 'name': self.archive.name}]
        self.upload()
        self.assertEqual(self.assets[:-1], others)
        self.assertEqual(self.assets[-1]['id'], 99)

    def test_wrong_release_identity_draft_or_immutable_release_stops_before_asset_changes(self):
        for change in [{'id': 43}, {'tag_name': 'v1.2.4'}, {'draft': True}, {'immutable': True}]:
            with self.subTest(change=change):
                original = dict(self.release)
                self.release.update(change)
                with self.assertRaises(ValueError):
                    self.upload()
                self.assertEqual(self.assets, [self.other])
                self.release = original

    def test_deleted_event_release_is_not_resolved_again_by_tag(self):
        with patch('urllib.request.urlopen', side_effect=HTTPError('fixture', 404, 'deleted release', {}, None)):
            with self.assertRaises(HTTPError):
                self.uploader().upload(self.archive, 'v1.2.3', 42)
        self.assertEqual(self.assets, [self.other])

    def test_corrupt_local_zip_is_rejected_before_deleting_existing_asset(self):
        self.assets.append({'id': 8, 'name': self.archive.name})
        self.archive.write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            self.upload()
        self.assertEqual([asset['id'] for asset in self.assets], [7, 8])
        self.assertEqual(self.requests, [])

    def test_invalid_credentials_repository_or_release_id_never_change_assets(self):
        for repository, token, release_id in [('owner/../tabs', 'fixture-token', 42), ('owner/tabs', '', 42), ('owner/tabs', 'fixture-token', 0)]:
            with self.subTest(repository=repository, token=bool(token), release_id=release_id):
                with patch('urllib.request.urlopen', side_effect=self.respond), self.assertRaises(ValueError):
                    self.uploader(repository, token).upload(self.archive, 'v1.2.3', release_id)
                self.assertEqual(self.assets, [self.other])
                self.assertEqual(self.requests, [])

    def test_upload_failure_is_reported_and_unrelated_assets_are_preserved(self):
        self.assets.append({'id': 8, 'name': self.archive.name})
        self.upload_error = HTTPError('fixture', 503, 'upload unavailable', {}, None)
        with self.assertRaises(HTTPError):
            self.upload()
        self.assertEqual(self.assets, [self.other])

    def test_uploaded_digest_mismatch_is_not_reported_as_success(self):
        self.bad_digest = True
        with self.assertRaisesRegex(ValueError, 'digest|checksum|SHA'):
            self.upload()


class ReleaseCliTest(ReleaseFixture):
    def test_cli_builds_locally_without_github_credentials(self):
        environment = {key: value for key, value in os.environ.items() if key not in {'GITHUB_TOKEN', 'GITHUB_REPOSITORY'}}
        result = subprocess.run([os.sys.executable, str(SCRIPT), '--tag', 'v1.2.3'], cwd=self.root,
                                env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        archive = self.root / 'dist' / 'sample-tabs_v1.2.3.zip'
        self.assertTrue(archive.exists(), 'CLI did not generate a ZIP')
        with zipfile.ZipFile(archive) as zipped:
            self.assertEqual(zipped.read('LICENSE'), self.git('show', 'HEAD:LICENSE'))

    def test_cli_invalid_tag_fails_without_creating_a_distribution(self):
        result = subprocess.run([os.sys.executable, str(SCRIPT), '--tag', '../unsafe'], cwd=self.root,
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'dist').exists())


if __name__ == '__main__':
    unittest.main()
