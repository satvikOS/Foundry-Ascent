# Common English words: source and licence

`common_english_10000.json` lists the 10,000 most frequent English words, most frequent first. The reference
library's relevance gate (`packages/db/src/knowledge-pack/gate.ts`) uses it to decide what is everyday English:
none of these words can name a library item on its own.

## Source

Derived from **wordfreq 3.1.1** by Robyn Speer (<https://github.com/rspeer/wordfreq>,
<https://doi.org/10.5281/zenodo.7199437>), file `wordfreq/data/large_en.msgpack.gz` of the PyPI wheel
`wordfreq-3.1.1-py3-none-any.whl` (SHA-256 of the wheel
`4b1c6ecffc6198be3396d5cf871c4423ca71c907c231348d352dd54d62b97473`, of the data file
`dffae8066b78dce0a6667cf5f58e567054f902674667090a7ac8a8a44628b05c`).

Extraction: the frequency buckets were read in order (most frequent first), and only words made of the letters
a–z (with at most one inner apostrophe, as in "don't") were kept, until 10,000 words were listed. Nothing else was
changed. Frequencies themselves are not reproduced.

## Licence

This list is a derivative of wordfreq's data and is distributed under the **Creative Commons
Attribution-ShareAlike 4.0 International** licence (<https://creativecommons.org/licenses/by-sa/4.0/>), the licence
wordfreq's data files are distributed under. You may share and adapt it, including commercially, if you give
appropriate credit and distribute your adaptations of this list under the same licence. The rest of this
repository is not affected by it.

wordfreq's README states the attributions its data requires, reproduced here:

- wordfreq contains data extracted from Google Books Ngrams (<http://books.google.com/ngrams>) and Google Books
  Syntactic Ngrams (<http://commondatastorage.googleapis.com/books/syntactic-ngrams/index.html>): "Ngram Viewer
  graphs and data may be freely used for any purpose, although acknowledgement of Google Books Ngram Viewer as the
  source, and inclusion of a link to http://books.google.com/ngrams, would be appreciated."
- Data derived from Creative Commons-licensed sources: the Leeds Internet Corpus, from the University of Leeds
  Centre for Translation Studies (<http://corpus.leeds.ac.uk/list.html>); Wikipedia, the free encyclopedia
  (<http://www.wikipedia.org>); ParaCrawl, a multilingual Web crawl (<https://paracrawl.eu>).
- Data from OPUS OpenSubtitles 2018 (<http://opus.nlpl.eu/OpenSubtitles.php>), whose data originates from the
  OpenSubtitles project (<http://www.opensubtitles.org/>), used with attribution to OpenSubtitles.
- Data from the SUBTLEX word lists (SUBTLEX-US, SUBTLEX-UK and others) created by Marc Brysbaert et al., available
  at <http://crr.ugent.be/programs-data/subtitle-frequencies>. SUBTLEX is freely available data; its authors are
  credited here as its conditions require.
- Some data was collected from the streaming Twitter API, in accordance with Twitter's Developer Agreement & Policy;
  no Twitter content is reproduced.
