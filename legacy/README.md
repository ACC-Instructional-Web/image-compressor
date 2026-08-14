# Legacy Tkinter app

This is the original desktop compressor. **It has been replaced by the browser tool in the
repo root** — see the top-level `README.md`.

It is kept here only as a reference for the original compression behavior. It is not
maintained and has known bugs (it re-compresses its own output on a second run, ignores EXIF
orientation so rotated photos come out sideways, crashes on RGBA PNGs, and does not resize).

To run it anyway:

```bash
../image_env/bin/python main.py
```

Note that `image_env/` is no longer tracked in git, so it only exists on machines where it was
already created.
