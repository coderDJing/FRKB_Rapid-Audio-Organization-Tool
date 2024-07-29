poetry config virtualenvs.in-project true
env remove python
env use python
pyinstaller .\src\analyseSongFingerprint.py --distpath=..\resources\pyScript\
