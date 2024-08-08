poetry config virtualenvs.in-project true
poetry env remove python
poetry env use python
pyinstaller .\src\analyseSongFingerprint.py --distpath=..\resources\pyScript\
