# Prompts written as image ALT text are accepted

2026-11-07. The owner first excluded ALT text, then reversed that after the X search research: about 35 full prompts a day (mostly Japanese) appear only in an image's ALT text, which the author writes just like the post. TwitterAPI.io already returns it, so it costs nothing extra.

The nightly prompt locator now sees each image's ALT text. A prompt it copies from there becomes an excerpt bound to that ALT text and image (`mediaKey`), and intake takes the body from the author's ALT text, never from the model's copy.
