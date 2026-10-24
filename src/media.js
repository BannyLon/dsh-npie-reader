/**
 * 文章附带的音频（播客源常见的 <enclosure type="audio/*">）。
 *
 * 本插件只解析音频地址，不构造任何视频嵌入地址。
 */

/** 只接受无凭据的 https 音频地址；类型声明存在时必须是 audio/*。 */
export function articleAudioUrl(article) {
  const value = typeof article?.audio === 'string' ? article.audio : article?.audio?.url;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const type = article?.audio?.type?.toLowerCase();
    return !type || type.startsWith('audio/') ? url.href : null;
  } catch { return null; }
}
