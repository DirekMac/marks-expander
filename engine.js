// ══════════════════════════════════════════════════════════
// Mark's Expander — engine.js
// Hosted on GitHub Pages. Edit this file to update ALL users
// instantly without them reinstalling the extension.
//
// VERSION: 1.0.0
// LAST UPDATED: 2025-07-19
// ══════════════════════════════════════════════════════════
// IMPORTANT: All code must be inside this self-executing
// function — it runs inside a content script context.

(function() {

var ACTIVE_KEY = 'me_active_snippets';
var snippets   = {};
var ready      = false;
var audioCtx   = null;

// ── Load snippets from local storage ──
function loadSnippets() {
  chrome.storage.local.get([ACTIVE_KEY], function(result) {
    snippets = result[ACTIVE_KEY] || {};
    ready    = true;
  });
}

chrome.storage.onChanged.addListener(function(changes, area) {
  if (area === 'local' && changes[ACTIVE_KEY]) {
    snippets = changes[ACTIVE_KEY].newValue || {};
    ready    = true;
  }
});

loadSnippets();
setInterval(loadSnippets, 60000);

// ── Pop sound via Web Audio API ──
function playPopSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    var osc  = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.06);
    gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.12);
  } catch(e) {}
}

// ── Expansion listener ──
document.addEventListener('input', function(e) {
  if (!ready) return;
  var el = e.target;
  if (!isEditable(el)) return;
  var word = getCurrentWord(el);
  if (!word) return;
  var expansion = snippets[word];
  if (expansion === undefined || expansion === null) return;
  doExpand(el, word, expansion);
  playPopSound();
}, true);

function isEditable(el) {
  if (!el || el.readOnly || el.disabled) return false;
  var tag = (el.tagName || '').toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    var type = (el.type || 'text').toLowerCase();
    return ['text','search','email','url','tel',''].indexOf(type) !== -1;
  }
  return !!el.isContentEditable;
}

function getCurrentWord(el) {
  var before = '';
  if (el.isContentEditable) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return '';
    var r  = sel.getRangeAt(0).cloneRange(); r.collapse(true);
    var pr = document.createRange();
    pr.selectNodeContents(el);
    pr.setEnd(r.startContainer, r.startOffset);
    before = pr.toString();
  } else {
    before = el.value.slice(0, el.selectionStart);
  }
  var m = before.match(/(\S+)$/);
  return m ? m[1] : '';
}

function doExpand(el, word, expansion) {
  if (el.isContentEditable) expandCE(el, word, expansion);
  else expandInput(el, word, expansion);
}

function expandInput(el, word, expansion) {
  var val = el.value, cur = el.selectionStart;
  var before = val.slice(0, cur);
  if (!before.endsWith(word)) return;
  var start  = cur - word.length;
  var newVal = val.slice(0, start) + expansion + val.slice(cur);
  var newCur = start + expansion.length;
  var proto  = el.tagName.toLowerCase() === 'textarea'
    ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  var desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, newVal); else el.value = newVal;
  el.setSelectionRange(newCur, newCur);
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function expandCE(el, word, expansion) {
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  var range = sel.getRangeAt(0);
  var node  = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return;
  var text = node.textContent, cur = range.startOffset;
  if (!text.slice(0, cur).endsWith(word)) return;
  var start = cur - word.length;
  node.textContent = text.slice(0, start) + expansion + text.slice(cur);
  var nr = document.createRange();
  nr.setStart(node, Math.min(start + expansion.length, node.textContent.length));
  nr.collapse(true); sel.removeAllRanges(); sel.addRange(nr);
}

})(); // end self-executing function
