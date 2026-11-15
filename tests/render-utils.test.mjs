import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTestTextInput } from '../public/render-utils.js';

test('escapes untrusted field names and values in generated HTML attributes', () => {
  const html = renderTestTextInput({
    name: `score" autofocus onfocus="alert(1)`,
    type: 'text',
    value: `"><script>alert(1)</script>`,
    placeholder: `Enter score" onmouseover="alert(1)`,
  });
  assert.equal(html.includes('autofocus onfocus="alert(1)'), false);
  assert.equal(html.includes('onmouseover="alert(1)'), false);
  assert.match(html, /score&amp;quot;|score&quot;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
