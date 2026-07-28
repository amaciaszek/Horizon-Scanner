# Horizon Profile Capture — browser prototype

A dependency-free mobile web prototype for capturing a practical skyline profile for the OnStep Advanced Telescope Controller.

## Included

- Live rear-camera access through `getUserMedia()`
- iOS motion/orientation permission flow
- Live heading, phone pitch, and roll readout
- Manual skyline tracing over the camera preview
- Overlapping-frame merge into 720 bins at 0.5° spacing
- Editable 360° altitude chart
- Geolocation metadata
- Explicit little-endian 764-byte `HZN1` export
- Demo profile for desktop testing

## Run locally

Camera and device orientation require a secure context. `localhost` is accepted by browsers for development:

```bash
python -m http.server 8000
```

Open `http://localhost:8000` on the same computer. For testing on a phone, deploy to GitHub Pages or another HTTPS host.

## Current projection limitation

This first version uses a deliberately simple projection from traced image coordinates to heading/altitude. It is enough to prove the complete capture/edit/export flow, but production capture should replace it with a camera-ray plus device-orientation rotation matrix and add overlap registration.

## HZN1 layout

| Offset | Size | Field |
|---:|---:|---|
| 0 | 4 | `HZN1` |
| 4 | 2 | sample count, uint16 LE |
| 6 | 2 | azimuth offset ×10, int16 LE |
| 8 | 4 | latitude, float32 LE |
| 12 | 4 | longitude, float32 LE |
| 16 | 4 | Unix epoch, uint32 LE |
| 20 | 24 | UTF-8 site name, zero padded |
| 44 | 720 | altitude ×2, uint8 |

Total: **764 bytes**.

Uncaptured bins export as 0° in this compatibility build. A future `HZN2` format should reserve 255 as missing and add CRC/versioned header fields.
