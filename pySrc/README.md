pip install poetry
poetry config virtualenvs.in-project true
poetry env remove python
poetry env use python
poetry install
poetry shell
pyinstaller .\src\analyseSongFingerprint.py --distpath=..\resources\pyScript\
