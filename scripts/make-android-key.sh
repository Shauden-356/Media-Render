#!/bin/sh
# Creates the signing key for the Imadia Android app (run once, on your own computer).
# Android only installs an update if it is signed with the same key as the installed app, so
# KEEP A BACKUP of the key file and its password: if it is lost, users must uninstall to update.
set -e
KEY="${1:-$HOME/imadia-android-release.jks}"
ALIAS=imadia
if [ -e "$KEY" ]; then echo "$KEY already exists; not overwriting it."; exit 1; fi
KEYTOOL="${JAVA_HOME:+$JAVA_HOME/bin/}keytool"
echo "Creating $KEY. keytool will ask for a password (use the same one twice when asked) and your name."
"$KEYTOOL" -genkeypair -v -keystore "$KEY" -alias "$ALIAS" -keyalg RSA -keysize 4096 -validity 10000
chmod 600 "$KEY"
echo
echo "Done. Now add these repository secrets on GitHub (Settings > Secrets and variables > Actions):"
echo "  ANDROID_KEYSTORE_BASE64   the output of:  base64 -i \"$KEY\" | pbcopy   (copies it)"
echo "  ANDROID_KEYSTORE_PASSWORD the password you just chose"
echo "  ANDROID_KEY_ALIAS         $ALIAS"
echo "  ANDROID_KEY_PASSWORD      the same password"
echo "Back up $KEY somewhere safe (not in the repository)."
