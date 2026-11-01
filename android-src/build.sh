#!/system/bin/sh
set -e
SDK=/data/user/0/com.dsh.android/files/termux/home/android-sdk
BT=$SDK/build-tools/37.0.0
AJAR=$SDK/platforms/android-36/android.jar
export JAVA_HOME=/data/user/0/com.dsh.android/files/termux/usr/lib/jvm/java-21-openjdk
export PATH=$JAVA_HOME/bin:$PATH
cd /storage/emulated/0/ark/android

LIBS=libs/shizuku-api.jar:libs/shizuku-provider.jar:libs/shizuku-aidl.jar:libs/shizuku-shared.jar

rm -rf build/gen build/classes build/dex build/apk
mkdir -p build/gen build/classes build/dex build/apk

echo "[1/5] aapt2 compile res"
aapt2 compile --dir res -o build/gen/res.zip

echo "[2/5] aapt2 link（含 assets）"
aapt2 link -o build/apk/base.apk -I "$AJAR" \
  --manifest AndroidManifest.xml \
  -A assets \
  --java build/gen/build \
  --min-sdk-version 24 --target-sdk-version 34 \
  build/gen/res.zip

echo "[3/5] javac"
find src build/gen -name '*.java' > build/sources.txt
javac --release 17 -classpath "$AJAR:$LIBS" -d build/classes @build/sources.txt

echo "[4/5] d8"
find build/classes -name '*.class' > build/classes.txt
# 注意：Shizuku 的 4 个 jar 必须作为「程序输入」给 d8（放在 --output 之后），
# 其中 aidl（moe.shizuku.server.*）与 shared（ShizukuApiConstants）是 api 的编译期依赖，
# 少一个就会在 ShizukuProvider 收 binder 时 NoClassDefFoundError 直接崩。
# 用 --classpath 只是编译期参考，类不会进 dex —— 那样 ShizukuProvider 在运行时就找不到，
# 应用会在一开始安装 ContentProvider 时直接 ClassNotFoundException 崩掉。
java -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 \
  --release --min-api 24 --lib "$AJAR" \
  --output build/dex @build/classes.txt libs/shizuku-api.jar libs/shizuku-provider.jar libs/shizuku-aidl.jar libs/shizuku-shared.jar

echo "[5/5] 打包 + 签名"
cp build/dex/classes.dex build/apk/classes.dex
cd build/apk
python3 /storage/emulated/0/ark/android/adddex.py base.apk classes.dex
cd ../..
java -jar "$BT/lib/apksigner.jar" sign \
  --ks build/arksim.keystore --ks-pass pass:arksim123 --key-pass pass:arksim123 \
  --out build/arksim.apk build/apk/base.apk
ls -la build/arksim.apk
