/**
 * Client-side Prism syntax highlighting for VS Code markdown preview.
 * Runs after each preview render. Prism core + languages are loaded
 * via markdown.previewScripts in package.json before this file.
 *
 * For languages not explicitly bundled, falls back to the `clike` grammar
 * (covers C-like syntax: keywords, strings, comments, numbers) so the block
 * still gets token colors rather than plain silver text.
 */
(function () {
  'use strict';

  function highlightAll() {
    if (typeof Prism === 'undefined') { return; }
    document.querySelectorAll('pre code[class*="language-"]').forEach(function (block) {
      // Skip blocks already tokenized this cycle
      if (block.querySelector('.token')) { return; }

      // Resolve the declared language; fall back to clike for unknowns
      var cls = Array.prototype.find.call(block.classList, function (c) {
        return c.startsWith('language-');
      });
      if (cls) {
        var lang = cls.slice('language-'.length);
        if (!Prism.languages[lang] && Prism.languages.clike) {
          block.classList.add('language-clike');
        }
      }

      Prism.highlightElement(block);
    });
  }

  // Initial highlight on load
  highlightAll();

  // Re-highlight when VS Code refreshes the preview content
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (msg && (msg.type === 'updateContent' || msg.type === 'codeBlockUpdate')) {
      setTimeout(highlightAll, 0);
    }
  });
}());
