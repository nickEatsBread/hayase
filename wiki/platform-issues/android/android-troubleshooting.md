# Android Troubleshooting

## WebView Issues

### What is Android System WebView?

Component that displays web content in apps.
Hayase uses WebView for UI.

### Outdated WebView Symptoms

* App crashes on launch
* Videos don't display
* UI looks broken
* Features missing
* JavaScript errors

### Updating System WebView

**Google Play Store:**

1. Open Google Play
2. Search "Android System WebView"
3. Update
4. Restart phone
5. Launch Hayase

### App Not Displaying Video

**Cause:** WebView doesn't support video codec

**Solution:**

1. Update WebView
2. Restart device

### App Crashes on Launch

**Solutions:**

1. Update WebView
2. Clear app data:
   Settings → Apps → Hayase → Storage → Clear Data
3. Reinstall Hayase
4. Restart phone

### Missing JavaScript Features

**Old WebView = missing features**

**Solution:**
Update to latest WebView

## Storage Permissions

**Grant permissions:**

```
Settings → Apps → Hayase → Permissions
→ Storage → Allow
```

**Android 11+:**
Hayase may request "All files access"

## Battery Optimization Problems

**Hayase killed in background:**

**Solution:**

```
Settings → Battery → Battery Optimization
→ All apps → Hayase
→ Don't optimize
```

**Manufacturer-specific:**

* Samsung: Settings → Device Care → Battery → Background usage limits
* Xiaomi: Security → Permissions → Autostart → Enable for Hayase
* Huawei: Settings → Battery → App launch → Hayase → Manual

## Casting Issues

**Can't cast:**

1. Same WiFi network?
2. Chromecast reachable?
3. Hayase has network permission?

**Choppy casting:**

* WiFi quality issue
* Too far from router
* Use 5GHz WiFi

## Performance on Low-End Devices

**Slow/laggy:**

* Lower video quality
* Close other apps

**Crashes:**

* Low RAM
* Consider upgrading device

***

**Related:** [Installation](../../getting-started/installation.md#mobile-android)
