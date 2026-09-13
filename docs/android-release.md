# Android releases through Obtainium

LamaSync's Android companion is distributed as one signed universal APK from
the public GitHub Release. Obtainium follows the repository's releases page:

```
https://github.com/aliforfaen/LamaSync
```

Each `vMAJOR.MINOR.PATCH` tag produces the `lamasync-android.apk` asset and
its `lamasync-android.apk.sha256` checksum. In Obtainium, add that URL with
the **GitHub** source. If it asks which release asset to use, select
`lamasync-android.apk` (or filter with `^lamasync-android\\.apk$`).

## Version and update contract

The Android package name is permanently `app.lamasync.companion`. Release
`versionName` is the tag without its leading `v`; `versionCode` is calculated
as `major * 1,000,000 + minor * 1,000 + patch`. Thus it is monotonic for the
supported `0..999` semantic-version components.

Before making a release, bump root `package.json` to the desired stable
`MAJOR.MINOR.PATCH` version, commit it, and tag that same commit as
`vMAJOR.MINOR.PATCH`. Do not retag or replace a published Android release:
Obtainium and installed devices need a new, higher version for an update.

## Signing key: preserve it forever

Android only accepts an update if its APK is signed by the *same* certificate
as the installed app. The private keystore and its passwords are therefore a
release credential, not a build artifact. They must never be committed, sent
in chat, or put in an issue.

The owner workstation stores them outside Git in:

```
android/credentials/lamasync-android-release.jks
android/credentials/release-keystore.properties
```

That directory is ignored by Git. Keep an encrypted backup of both files in a
separate private location before publishing the first APK. Losing either the
keystore or its passwords means existing installs cannot be updated; the only
recovery is a new application ID and a fresh install.

`release-keystore.properties` has this exact shape (the generated local copy
already has the real values):

```properties
storeFile=credentials/lamasync-android-release.jks
storePassword=...
keyAlias=lamasync-android
keyPassword=...
```

To make a manual signed APK after the credential files exist:

```bash
./android/gradlew -p android assembleRelease -PlamasyncVersionName=0.3.11
sha256sum android/app/build/outputs/apk/release/app-release.apk
```

The Gradle build deliberately refuses release APK tasks without all four
credential values. Debug builds remain available to developers but are neither
uploaded by CI nor published as a user distribution channel.

## GitHub Actions one-time setup

The tag workflow reads four repository Actions secrets. Their current values
are stored in the repository's [Actions secrets settings](https://github.com/aliforfaen/LamaSync/settings/secrets/actions);
update them there only if the signing key is intentionally rotated. Add them
before pushing the first `v*` tag:

| Secret | Value |
| --- | --- |
| `LAMASYNC_ANDROID_KEYSTORE_BASE64` | Base64 of `lamasync-android-release.jks` as one line |
| `LAMASYNC_ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `LAMASYNC_ANDROID_KEY_ALIAS` | `lamasync-android` |
| `LAMASYNC_ANDROID_KEY_PASSWORD` | Key password |

Generate the first value locally without printing the password:

```bash
base64 -w 0 android/credentials/lamasync-android-release.jks
```

After the secrets are present, push a matching semantic-version tag. CI builds
the signed APK, creates its checksum, and attaches both files to the
GitHub Release. Install the first release manually from Obtainium, then use
Obtainium's normal update action for later releases.
