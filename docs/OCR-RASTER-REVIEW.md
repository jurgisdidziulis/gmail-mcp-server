# Internal raster OCR review component

This introduces real local OCR execution for a bounded PNG raster using fixed
`/usr/bin/tesseract` and the existing English model at
`/usr/share/tesseract-ocr/5/tessdata/eng.traineddata`. No model downloads, network
calls, arbitrary executable arguments or paid service are used. The executable
and model hashes are recorded with raster/text hashes and page declarations.

Limits: one process, 2 MiB PNG, 4 million pixels, 10 seconds, 256 MiB monitored
RSS, one OpenMP thread, 40,000 characters and bounded diagnostics. Engine errors,
missing dependencies, invalid declarations and empty text remain held. Root
execution drops the OCR child to nobody. This is process isolation, not a claim
of a complete OS sandbox or proven peak-memory containment.

Results are always review-only and incomplete. A declared original digest is
explicitly unverified: this module cannot prove which PDF generated a raster.
It neither validates invoice facts nor authorizes downstream business effects.

The explicit internal `reviewPdfOcr` path now binds bounded PDF.js rendering to
the original PDF bytes, verifies every ordered page and raster digest, and invokes
the OCR component. It accepts at most three pages, keeps a 30-second total budget
and preserves password/form/annotation and malformed-document holds. Oversized
render surfaces stop before canvas allocation; no partial page list is returned.
The existing normal extraction path never selects this rendering mode or invokes
OCR automatically. Text PDFs are not routed through OCR.

The candidate Docker image installs Debian's Tesseract and English model during
build, checks the fixed model path and removes package indexes. The existing
Node 22.23.4 base is retained. Package revisions are resolved by Debian at build
time; per-result engine/model hashes identify the actual binaries, rather than
claiming immutable package versions. The optional BuildKit `proxy_ca` certificate
mount supports managed builds without retaining that certificate in image layers
or disabling npm TLS verification. The build context excludes local data and keys.

Reproduce the container regression check after building the image:

```sh
docker run --rm --network=none --mount type=bind,src="$PWD/test",dst=/app/test,readonly \
  office-gmail-ocr-review:20261027 node --test --test-concurrency=1 \
  test/ocr-evidence.test.mjs test/pdf-evidence.test.mjs \
  test/ocr-pdf-review.test.mjs test/ocr-review.test.mjs test/pdf-worker.test.mjs \
  test/pdf-note-review.test.mjs test/pdf-form-review.test.mjs
```

The existing `get_thread_evidence` tool now accepts `ocr_review: true` (default
false). It only runs OCR when the server also sets `PDF_OCR_REVIEW_ENABLED=true`
and normal PDF evidence is enabled. The original attachment must first pass the
existing provider/source/hash binding and be held for visual/OCR review. Text,
forms, annotations and other failure paths never invoke OCR. Only one attachment
per thread can enter OCR, with the renderer's existing three-page cap.

OCR output appears only in `pdfs[].ocr_review`. The PDF remains incomplete, its
original hold/error is retained, and no top-level accepted `text` or `pages` are
added. Overall success and PDF completeness remain false. A second eligible
attachment receives `ocr_thread_attempt_limit`; it never silently disappears.
Both activation gates are required; deploying this code alone does not enable
OCR on routine mail reads. A locally built image is not production acceptance.

Validation uses synthetic rasters and the actual installed Tesseract engine;
it does not refetch any private original document or replace the earlier PDF
worker acceptance. English-only behavior must not be advertised as Lithuanian
or multilingual OCR.
