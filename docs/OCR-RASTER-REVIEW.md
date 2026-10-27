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

The deployed PDF extractor is unchanged. Next integration must independently bind
bounded rendering to the original PDF bytes, preserve JavaScript/form/password
and other unsupported-content holds, manage multi-page completeness, and install
the engine/model through the reviewed image build. Do not invoke this helper as
an automatic fallback or mark production OCR ready from the component tests.

Validation uses synthetic rasters and the actual installed Tesseract engine;
it does not refetch any private original document or replace the earlier PDF
worker acceptance. English-only behavior must not be advertised as Lithuanian
or multilingual OCR.
