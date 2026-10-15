"""Bundled Python -m unittest discover -s resources/rekordboxDesktopLibrary.

Exercise the real 0.5.0 ORM and commits against a private encrypted fixture only.
"""

import datetime
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import MetaData, create_engine
from sqlalchemy.orm import Session
from sqlcipher3 import dbapi2
from pyrekordbox.masterdb.database import BLOB
from pyrekordbox.utils import deobfuscate

import bridge_playlist_writes as writes
import bridge_runtime as runtime


def model_values(model, **overrides):
    values = {}
    for column in model.__table__.columns:
        if column.nullable or column.default is not None:
            continue
        if column.key.startswith('date_'):
            values[column.key] = datetime.datetime.now()
        else:
            values[column.key] = 0 if column.type.python_type in (int, float) else ''
    return model(**{**values, **overrides})


class MasterDatabaseIntegrationTests(unittest.TestCase):
    def test_encrypted_path_lookup_append_reorder_and_remove_commit(self):
        self.assertIsNone(runtime.PYREKORDBOX_IMPORT_ERROR)
        with tempfile.TemporaryDirectory() as temporary:
            db_path = Path(temporary) / 'master.db'
            key = deobfuscate(BLOB)
            engine = create_engine(f'sqlite+pysqlcipher://:{key}@/{db_path}?', module=dbapi2)
            schema = MetaData()
            for table in runtime.tables.Base.metadata.sorted_tables:
                copied = table.to_metadata(schema)
                # Native master.db permits NULL USNs before the first commit;
                # pyrekordbox's ORM metadata incorrectly declares them NOT NULL.
                for name in ('usn', 'rb_local_usn'):
                    if name in copied.c:
                        copied.c[name].nullable = True
            schema.create_all(engine)
            with Session(engine) as session:
                session.add(model_values(runtime.tables.AgentRegistry,
                                         registry_id='localUpdateCount', int_1=100))
                session.add(model_values(runtime.tables.DjmdPlaylist,
                                         ID='10', Name='Fixture', ParentID='root', Seq=1))
                for index in range(1, 4):
                    session.add(model_values(runtime.tables.DjmdContent,
                                             ID=str(index), Title=f'Track {index}',
                                             FolderPath=f'C:/Music/Track {index}.mp3'))
                session.commit()
            engine.dispose()

            config = {'available': True, 'dbPath': str(db_path), 'dbDir': temporary}
            with ExitStack() as cleanup:
                cleanup.enter_context(patch('pyrekordbox.masterdb.database.get_rekordbox_pid', return_value=0))

                def open_fixture(request):
                    opened = runtime._open_database(request)
                    cleanup.callback(opened.engine.dispose)
                    return opened

                cleanup.enter_context(patch.object(writes, '_open_database', side_effect=open_fixture))
                db = runtime._open_database(config)
                try:
                    track, added = writes._resolve_track_content(db, r'C:\Music\Track 1.mp3')
                    self.assertFalse(added)
                    self.assertEqual(track.ID, '1')
                    for index in range(1, 4):
                        db.add_to_playlist('10', str(index))
                    db.commit()
                finally:
                    db.close()
                    db.engine.dispose()

                with patch.object(writes, '_ensure_request_config', return_value=config):
                    writes._build_reorder_playlist_tracks_payload({
                        'playlistId': 10,
                        'rowKeys': ['rekordbox-desktop:10:3:3'],
                        'targetIndex': 0,
                    })
                db = runtime._open_database(config)
                try:
                    rows = db.get_playlist_songs(PlaylistID='10').order_by(
                        runtime.tables.DjmdSongPlaylist.TrackNo).all()
                    self.assertEqual([row.ContentID for row in rows], ['3', '1', '2'])
                    self.assertEqual([row.TrackNo for row in rows], [1, 2, 3])
                    self.assertTrue(all(row.rb_local_usn > 100 for row in rows))
                    usn = db.get_local_usn()
                finally:
                    db.close()
                    db.engine.dispose()

                with patch.object(writes, '_ensure_request_config', return_value=config):
                    writes._build_remove_playlist_tracks_payload({
                        'playlistId': 10, 'rowKeys': ['rekordbox-desktop:10:2:1'],
                    })
                db = runtime._open_database(config)
                try:
                    rows = db.get_playlist_songs(PlaylistID='10').order_by(
                        runtime.tables.DjmdSongPlaylist.TrackNo).all()
                    self.assertEqual([row.ContentID for row in rows], ['3', '2'])
                    self.assertEqual([row.TrackNo for row in rows], [1, 2])
                    self.assertGreater(db.get_local_usn(), usn)
                finally:
                    db.close()
                    db.engine.dispose()


if __name__ == '__main__':
    unittest.main()
