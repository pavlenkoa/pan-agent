import { describe, expect, it } from 'vitest';

import { markdownToTelegramHtml } from './telegram-format.js';

describe('markdownToTelegramHtml', () => {
  it('renders the exact screenshot regression: bold, inline code, and a fenced shell block', () => {
    const md = [
      'Так, саме так. Обери коротку назву акаунту (наприклад `ACME`) і виконай сам через Telegram:',
      '',
      '```',
      '/set_var ESPUTNIK_EMAIL_ACME твій_email_від_eSputnik',
      '/set_var ESPUTNIK_PASSWORD_ACME твій_пароль',
      '```',
      '',
      'Я ці значення не бачу — тільки дізнаюсь, що вони встановлені.',
    ].join('\n');
    const html = markdownToTelegramHtml(md);
    expect(html).toContain('<code>ACME</code>');
    expect(html).toContain('<pre><code>/set_var ESPUTNIK_EMAIL_ACME твій_email_від_eSputnik\n/set_var ESPUTNIK_PASSWORD_ACME твій_пароль</code></pre>');
    expect(html).not.toContain('```');
    expect(html).not.toContain('`ACME`');
  });

  it('converts bold, italic, and strikethrough', () => {
    expect(markdownToTelegramHtml('**bold** and *italic* and ~~gone~~')).toBe(
      '<b>bold</b> and <i>italic</i> and <s>gone</s>',
    );
  });

  it('converts a fenced code block with a language hint', () => {
    const html = markdownToTelegramHtml('```ts\nconst x = 1;\n```');
    expect(html).toBe('<pre><code class="language-ts">const x = 1;</code></pre>');
  });

  it('converts markdown links', () => {
    expect(markdownToTelegramHtml('see [the docs](https://example.com/x)')).toBe(
      'see <a href="https://example.com/x">the docs</a>',
    );
  });

  it('folds headers into bold and blockquotes into <blockquote>', () => {
    expect(markdownToTelegramHtml('# Title\n> quoted line')).toBe('<b>Title</b>\n<blockquote>quoted line</blockquote>');
  });

  it('converts bullet markers to a bullet character without touching numbered lists', () => {
    expect(markdownToTelegramHtml('- one\n- two\n1. first')).toBe('• one\n• two\n1. first');
  });

  it('escapes raw HTML-special characters outside any markdown construct', () => {
    expect(markdownToTelegramHtml('5 < 10 && 10 > 5')).toBe('5 &lt; 10 &amp;&amp; 10 &gt; 5');
  });

  it('escapes HTML-special characters inside code without treating them as markdown', () => {
    expect(markdownToTelegramHtml('`a < b && c`')).toBe('<code>a &lt; b &amp;&amp; c</code>');
  });

  it('does not format emphasis markers that live inside code spans', () => {
    expect(markdownToTelegramHtml('`**not bold**`')).toBe('<code>**not bold**</code>');
  });
});
