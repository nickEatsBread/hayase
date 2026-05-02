# Installation

Hayase is available on multiple platforms. Choose your platform below for specific installation instructions.

## Desktop (Windows/Linux/macOS)

### Windows

**System Requirements:**

* Windows 10 or later (64-bit)
* 3GB RAM minimum (4GB recommended)
* 1GB free disk space for the application
* Additional space for content (depends on your usage)

**Installation Steps:**

1. Download the latest Windows installer (`.exe`) from the official Hayase website
2. Run the installer
3. Follow the installation wizard
4. Launch Hayase from the Start Menu or desktop shortcut

**First Launch:**

* Windows Defender may show a warning for new applications - this is normal
* You may see "Windows protected your PC" or "Unknown publisher" warnings because Hayase is not code-signed (code signing costs hundreds of dollars annually and doesn't actually improve security - it just means someone paid Microsoft for a certificate). Click **More info** → **Run anyway** to proceed.
* If your antivirus blocks Hayase, you may need to add an exception (see [Windows Troubleshooting](../platform-issues/windows/windows-troubleshooting.md))

### Linux

**System Requirements:**

* Modern Linux distribution (Ubuntu 20.04+, Fedora 35+, Arch, etc.)
* 3GB RAM minimum (4GB recommended)
* 1GB free disk space for the application
* X11 or Wayland display server

**Installation Options:**

#### Package Managers

Hayase doesn't have official packages in most distro repositories or package managers, they are numerous and vary by distribution, have strict rules, increase development overhead, as such it's unlikely that Hayase will be added to most package managers. Please use the AppImage or distribution packages below.

#### AppImage (Recommended for most users)

AppImages work on virtually any Linux distribution:

1. Download the `.AppImage` file
2. Make it executable:
   ```bash
   chmod +x Hayase-*.AppImage
   ```
3. Run it:
   ```bash
   ./Hayase-*.AppImage
   ```

#### Distribution Packages

Some distributions provide native packages `.deb`:

**Debian/Ubuntu:**

```bash
sudo dpkg -i hayase_*.deb
sudo apt-get install -f  # Install dependencies
```

**First Launch Notes:**

* You may need to install additional libraries depending on your distribution
* See [Linux Display Server Issues](../platform-issues/linux/display-server-issues.md) if the app doesn't start
* See [Linux GPU Acceleration](../platform-issues/linux/gpu-acceleration.md) for video playback issues

### macOS

**System Requirements:**

* macOS 10.15 (Catalina) or later
* 4GB RAM minimum (8GB recommended)
* 1GB free disk space for the application
* Works on both Intel and Apple Silicon (M) Macs

**Installation Steps:**

1. Download the macOS `.dmg` file
2. Open the downloaded `.dmg`
3. Drag Hayase to your Applications folder
4. Launch Hayase from Applications

**First Launch - Security Warning:**

On first launch, macOS will show a security warning because Hayase is not from the Mac App Store:

1. Go to **System Preferences** → **Security & Privacy**
2. Click **Open Anyway** next to the Hayase warning
3. Confirm you want to open the application

Alternatively, you can right-click the app and select **Open** to bypass the warning.

**Apple Silicon (M1/M2/M3) Notes:**

* Native ARM builds are available for better performance in the same binary, it's detected automatically
* See [macOS Troubleshooting](../platform-issues/macos/macos-troubleshooting.md) for any issues

## Mobile (Android)

**System Requirements:**

* Android 8.0 (Oreo) or later
* 2GB RAM minimum (4GB recommended)
* 100MB free space for the application
* Additional space for content

**Installation Steps:**

1. Download the `.apk` file
2. Enable **Install from Unknown Sources** if prompted:
   * Go to **Settings** → **Security** → **Unknown Sources**
   * Or **Settings** → **Apps** → **Special Access** → **Install unknown apps**
3. Open the downloaded `.apk` file
4. Follow the installation prompts
5. Launch Hayase from your app drawer

**Important - WebView Dependency:**

Hayase on Android relies on **Android System WebView**. If you experience issues:

* The app crashes on launch
* Videos don't play
* The interface looks broken

You need to update your WebView. See [Android WebView Issues](../platform-issues/android/android-troubleshooting.md#webview-issues) for detailed instructions.

**Permissions:**

Hayase will request these permissions:

* **Network**: To connect to torrent peers
* **Notification Access**: To show playback controls in the notification shade

## iOS Limitations

**Hayase is NOT available on iOS** (iPhone/iPad) due to Apple's platform restrictions:

### Why No iOS Version?

1. **No torrenting allowed**: Apple prohibits BitTorrent clients in the App Store
2. **Sideloading restrictions**: Even sideloaded apps have severe limitations
3. **Background restrictions**: iOS kills background processes aggressively, breaking torrent connectivity
4. **WebRTC limitations**: iOS Safari restricts peer-to-peer connections needed for Watch2Gether
5. **WASI limitations**: iOS has limited support for WebAssembly System Interface, which Hayase relies on

### Alternatives for iOS Users

If you need to use Hayase and only have an iOS device:

* **Use Hayase on another device** and cast to a ChromeCast enabled TV
* **Access via a computer** (macOS, Windows, Linux) and share your screen
* **Buy An Android Device** for a portable Hayase experience

We understand this is frustrating, but these are fundamental iOS platform limitations that cannot be worked around, Apple hates developers.

## Verifying Your Installation

After installation, verify Hayase is working:

1. Launch the application
2. The main interface should load
3. Navigate through the setup wizard if it's your first time

If you encounter issues:

* **Windows**: See [Windows Troubleshooting](../platform-issues/windows/windows-troubleshooting.md)
* **Linux**: See [Linux Issues](../platform-issues/linux/general-linux-issues.md)
* **macOS**: See [macOS Troubleshooting](../platform-issues/macos/macos-troubleshooting.md)
* **Android**: See [Android Troubleshooting](../platform-issues/android/android-troubleshooting.md)

***

**Next Steps:**

* [First Time Setup](first-time-setup.md)
* [Installing Extensions](../extensions/overview.md)
* [Understanding Torrent Streaming](../core-concepts/torrent-streaming.md)
