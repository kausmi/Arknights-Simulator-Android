import sys, zipfile, shutil
apk, dex = sys.argv[1], sys.argv[2]
tmp = apk + ".tmp"
with zipfile.ZipFile(apk) as zin, zipfile.ZipFile(tmp, "w") as zout:
    for it in zin.infolist():
        data = zin.read(it.filename)
        zi = zipfile.ZipInfo(it.filename, date_time=it.date_time)
        zi.compress_type = zipfile.ZIP_STORED if it.compress_type == zipfile.ZIP_STORED else zipfile.ZIP_DEFLATED
        zi.external_attr = it.external_attr
        zout.writestr(zi, data)
    zout.write(dex, "classes.dex", compress_type=zipfile.ZIP_DEFLATED)
shutil.move(tmp, apk)
with zipfile.ZipFile(apk) as z:
    for i in z.infolist():
        print(i.filename, "stored" if i.compress_type == 0 else "deflate")
