// API documentation page: fills in this server's address and wires the copy buttons.
import { $$, $, copyText } from './common.js';

const origin = location.origin;

// Examples are written with {{ORIGIN}}, so a copied command points at the server the page came from.
for (const el of document.querySelectorAll('pre, code')) {
  if (el.textContent.includes('{{ORIGIN}}')) el.textContent = el.textContent.replaceAll('{{ORIGIN}}', origin);
}
for (const el of $$('[data-origin]')) el.textContent = origin;

for (const button of $$('[data-copy]')) {
  button.addEventListener('click', async () => {
    const text = $(`#${button.dataset.copy}`).textContent;
    const ok = await copyText(text);
    button.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => (button.textContent = 'Copy'), 1600);
  });
}
