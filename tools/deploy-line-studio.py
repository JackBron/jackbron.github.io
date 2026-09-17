#!/usr/bin/env python3
"""
Deploy Line Studio into line-studio/index.html.

The published copy is not a byte-for-byte copy of the app: it carries a
"back to the project index" link in the rail that has no business in the
standalone file you open from disk. That patch lives here rather than in
anyone's memory, because a plain `cp` of the next revision silently deletes
it and the loss is invisible until someone goes looking for the link.

Usage:
    python tools/deploy-line-studio.py                  # newest revision found
    python tools/deploy-line-studio.py <path-to-html>   # a specific file

Idempotent: re-running against an already-patched file changes nothing.
"""

import io
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(REPO, 'line-studio', 'index.html')

# Where revisions are kept, newest wins. First existing directory is used.
SOURCE_DIRS = [
    os.path.join(REPO, 'Cooking_Mode'),
    os.path.abspath(os.path.join(REPO, '..', '..', 'Python Scripts', 'Cooking_Mode')),
]

CSS_ANCHOR = ".rbtn.on{background:var(--flame);color:#1a1200;border-color:transparent}"
CSS_PATCH = (
    "\na.rbtn{display:inline-flex;align-items:center;gap:6px;text-decoration:none}"
    "\na.rbtn .home-ico{opacity:.85}"
)

RAIL_ANCHOR = '<button class="rbtn" id="btnTheme">Night</button>'
RAIL_PATCH = (
    '\n  <a class="rbtn" href="../" title="Back to the project index">'
    '<svg class="home-ico" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" '
    'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" '
    'stroke-linejoin="round"><path d="M2 7l6-4.5L14 7"/><path d="M3.5 6.5V13h9V6.5"/>'
    '</svg>Index</a>'
)

# drive.js adds the "Import from Drive" button. It is a separate file so the
# app itself stays a single openable-from-disk document; this only wires it in.
# The app has no </body> — it ends at its one closing </script> — so that is
# the anchor, and the check below asserts it really is unique before using it.
SCRIPT_ANCHOR = '</script>'
SCRIPT_PATCH = '\n<script src="./drive.js"></script>'


def newest_revision():
    for d in SOURCE_DIRS:
        if not os.path.isdir(d):
            continue
        found = []
        for name in os.listdir(d):
            m = re.fullmatch(r'line_studio_r(\d+)\.html', name)
            if m:
                found.append((int(m.group(1)), os.path.join(d, name)))
        if found:
            return max(found)[1]
    sys.exit('No line_studio_r*.html found in:\n  ' + '\n  '.join(SOURCE_DIRS))


def apply_patch(html, anchor, patch, label, unique=False):
    if patch.strip() in html:
        return html, 'already present'

    n = html.count(anchor)
    if n == 0:
        sys.exit('Cannot deploy: anchor for %s not found.\n'
                 'The app\'s markup changed — re-check the patch against the new revision.\n'
                 '  anchor: %s' % (label, anchor[:70]))
    if unique and n != 1:
        # Appending after the *first* of several would land the patch in the
        # middle of the document. Better to stop than to guess.
        sys.exit('Cannot deploy: anchor for %s appears %d times, expected once.\n'
                 '  anchor: %s' % (label, n, anchor[:70]))

    # anchored on the last occurrence so end-of-document patches stay at the end
    i = html.rfind(anchor) + len(anchor)
    return html[:i] + patch + html[i:], 'applied'


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else newest_revision()
    html = io.open(src, encoding='utf-8').read()

    rev = re.search(r'LINE STUDIO&nbsp;&nbsp;(r\d+)', html)
    rev = rev.group(1) if rev else '?'

    html, css_state = apply_patch(html, CSS_ANCHOR, CSS_PATCH, 'index-link CSS')
    html, rail_state = apply_patch(html, RAIL_ANCHOR, RAIL_PATCH, 'index-link anchor')
    html, drive_state = apply_patch(html, SCRIPT_ANCHOR, SCRIPT_PATCH,
                                    'drive.js script tag', unique=True)

    io.open(DEST, 'w', encoding='utf-8', newline='\n').write(html)

    print('source   %s' % os.path.basename(src))
    print('revision %s' % rev)
    print('css      %s' % css_state)
    print('rail     %s' % rail_state)
    print('drive    %s' % drive_state)
    print('written  line-studio/index.html (%d bytes)' % len(html.encode('utf-8')))

    if not os.path.exists(os.path.join(REPO, 'line-studio', 'drive.js')):
        print('\nWARNING: line-studio/drive.js is missing — the page will 404 on it.')


if __name__ == '__main__':
    main()
