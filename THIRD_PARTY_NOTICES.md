# Third-party notices

Video metadata, WBI signing, subtitle selection and QR-login flows were adapted
from the user's existing dsh-bilibili integration, derived from CZX2244/dsh-bilibili.
See LICENSE-DSH for the original MIT license and copyright notice.

Cloud runtime uses qrcode-generator, jpeg-js, @noble/hashes and esbuild under
their respective licenses, preserved by the package lock and build output.

Website-session write API payloads were checked against primary client sources:

- https://github.com/biliup/biliup/tree/master/crates/biliup/src/uploader
- https://github.com/bggRGjQaUbCoE/PiliPlus/tree/main/lib/http
- https://github.com/Yuelioi/bpi-rs

These website interfaces are not a guaranteed Bilibili Open Platform contract.
No CAPTCHA, risk-control bypass, proxy rotation or bulk-engagement workflow is implemented.
# PNG decoding

pngjs 7.0.0 is used by the hosted backend to decode PNG timeline sheets. License: MIT. Source: https://github.com/pngjs/pngjs .

