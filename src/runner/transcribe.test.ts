import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseTranscription, transcribeAudio } from './transcribe.js';

describe('parseTranscription', () => {
  it('reads and trims text from a plain json response', () => {
    expect(parseTranscription({ text: '  Привіт, світе.  ' })).toBe('Привіт, світе.');
  });

  it('reads text from a verbose_json response, ignoring segments', () => {
    expect(parseTranscription({ text: 'hello', language: 'en', segments: [{ id: 0, text: 'hello' }] })).toBe('hello');
  });

  it('accepts an empty transcript (silence) as an empty string, not an error', () => {
    expect(parseTranscription({ text: '' })).toBe('');
  });

  it('rejects responses without a text field', () => {
    expect(() => parseTranscription({ error: 'nope' })).toThrow();
    expect(() => parseTranscription(null)).toThrow();
    expect(() => parseTranscription('text')).toThrow();
  });
});

describe('transcribeAudio', () => {
  afterEach(() => vi.unstubAllGlobals());

  const cfg = { transcribeUrl: 'http://host.internal:50060', transcribeModel: 'large-v3-turbo' };

  it('posts the audio as multipart to /v1/audio/transcriptions with model and json format', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: 'ok' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await transcribeAudio(cfg, Buffer.from('RIFFfake'))).toBe('ok');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://host.internal:50060/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('large-v3-turbo');
    expect(form.get('response_format')).toBe('json');
    expect((form.get('file') as File).name).toBe('voice.ogg');
    expect((form.get('file') as File).type).toBe('audio/ogg');
  });

  it('sends a non-empty model field even when none is configured, since the server rejects an empty one', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: 'ok' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await transcribeAudio({ transcribeUrl: 'http://stt.invalid', transcribeModel: '' }, Buffer.from('x'));
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect((init.body as FormData).get('model')).toBeTruthy();
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(transcribeAudio(cfg, Buffer.from('x'))).rejects.toThrow(/500/);
  });

  it('throws when no endpoint is configured, without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(transcribeAudio({ transcribeUrl: null, transcribeModel: '' }, Buffer.from('x'))).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
