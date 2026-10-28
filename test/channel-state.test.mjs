/**
 * 频道浏览状态（0.44.9）：每源记住筛选 / 搜索词 / 列表滚动位置。
 *
 * 三条**都不报错**的错法：
 *   ① 一项坏掉就整条丢掉 ⇒ 用户「刚设好的筛选」因为一个不相干的字段坏掉而一起没了；
 *   ② `scroll` 用 `||` 兜默认值 ⇒ 滚回顶部存不进去，下次进来又跳回中间；
 *   ③ 切频道时不清理「待还原」标记就写盘 ⇒ 把「列表刚被清空」的 0 写进去，
 *      上次的位置被抹掉，从此永远在顶上。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  CHANNEL_STATE_LIMIT, clearChannelState, readChannelState, saveChannelState,
} from '../src/client/channel-state.js';
import { stripComments } from '../scripts/strip-comments.mjs';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function fakeStorage({ failOnWrite = false } = {}) {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem(key, value) {
      if (failOnWrite) throw new Error('QuotaExceededError');
      map.set(key, String(value));
    },
    removeItem(key) { map.delete(key); },
  };
}

describe('0.44.9：频道状态 —— 存取', () => {
  it('没记过时给默认值', () => {
    assert.deepEqual(readChannelState('feeds:all', fakeStorage()), { filter: 'all', query: '', scroll: 0 });
    assert.deepEqual(readChannelState('', fakeStorage()), { filter: 'all', query: '', scroll: 0 });
  });

  it('存进去能读回来，且按频道分开', () => {
    const storage = fakeStorage();
    saveChannelState('a', { filter: 'unread', query: '笔记' }, storage);
    saveChannelState('b', { filter: 'favorites' }, storage);
    assert.equal(readChannelState('a', storage).filter, 'unread');
    assert.equal(readChannelState('a', storage).query, '笔记');
    assert.equal(readChannelState('b', storage).filter, 'favorites');
    assert.equal(readChannelState('b', storage).query, '');
  });

  it('★ 单项坏掉只回落那一项（不整条丢弃）', () => {
    const storage = fakeStorage();
    // 上一版可能把 filter 写成下标
    storage.map.set('npr.channelState', JSON.stringify({ a: { filter: 2, query: '保留我' } }));
    const state = readChannelState('a', storage);
    assert.equal(state.filter, 'all', '不认识的筛选项没回落');
    assert.equal(state.query, '保留我', '筛选项坏掉把搜索词也带走了 —— 用户刚输入的东西没了');
  });

  it('未知筛选项一律回落 all', () => {
    const storage = fakeStorage();
    storage.map.set('npr.channelState', JSON.stringify({ a: { filter: 'deleted' } }));
    assert.equal(readChannelState('a', storage).filter, 'all');
  });

  it('★ scroll 传 0 必须存得进去（滚回顶部是正常状态）', () => {
    const storage = fakeStorage();
    saveChannelState('a', { scroll: 1200 }, storage);
    assert.equal(readChannelState('a', storage).scroll, 1200);
    saveChannelState('a', { scroll: 0 }, storage);
    assert.equal(readChannelState('a', storage).scroll, 0,
      '滚回顶部没存进去 —— 下次进来又跳回中间');
  });

  it('没传的字段沿用旧值（合并而不是覆盖）', () => {
    const storage = fakeStorage();
    saveChannelState('a', { filter: 'unread', query: 'x', scroll: 300 }, storage);
    saveChannelState('a', { scroll: 900 }, storage);
    const state = readChannelState('a', storage);
    assert.equal(state.filter, 'unread');
    assert.equal(state.query, 'x');
    assert.equal(state.scroll, 900);
  });

  it('搜索词超长会被截断（多半是误粘贴）', () => {
    const storage = fakeStorage();
    saveChannelState('a', { query: 'x'.repeat(500) }, storage);
    assert.ok(readChannelState('a', storage).query.length <= 120);
  });

  it('坏 JSON / 配额满都不抛', () => {
    const broken = fakeStorage();
    broken.map.set('npr.channelState', '{ 不是 json');
    assert.deepEqual(readChannelState('a', broken), { filter: 'all', query: '', scroll: 0 });
    assert.doesNotThrow(() => saveChannelState('a', { filter: 'all' }, fakeStorage({ failOnWrite: true })));
  });

  it('★ 超过上限按最后使用时间淘汰', () => {
    const storage = fakeStorage();
    for (let index = 0; index <= CHANNEL_STATE_LIMIT; index += 1) {
      saveChannelState(`c${index}`, { filter: 'all' }, storage);
      // 同毫秒会让排序退化成插入顺序，显式岔开
      const all = JSON.parse(storage.map.get('npr.channelState'));
      all[`c${index}`].at = index;
      storage.map.set('npr.channelState', JSON.stringify(all));
    }
    const all = JSON.parse(storage.map.get('npr.channelState'));
    assert.equal(Object.keys(all).length, CHANNEL_STATE_LIMIT);
    assert.equal(all.c0, undefined, '最久没用的那个没被淘汰');
    assert.ok(all[`c${CHANNEL_STATE_LIMIT}`], '刚写的反而被删了');
  });

  it('clearChannelState 只清那一个', () => {
    const storage = fakeStorage();
    saveChannelState('a', { filter: 'unread' }, storage);
    saveChannelState('b', { filter: 'favorites' }, storage);
    clearChannelState('a', storage);
    assert.equal(readChannelState('a', storage).filter, 'all');
    assert.equal(readChannelState('b', storage).filter, 'favorites');
  });
});

describe('0.44.9：频道状态 —— 组件接线', () => {
  const reader = stripComments(readFileSync(join(pluginRoot, 'src', 'client', 'ReaderPage.jsx'), 'utf8'));

  it('首帧就从 localStorage 取（否则会先用默认值发一次请求）', () => {
    assert.match(reader, /initialBrowseState\(\)/, '首帧没取状态 —— 打开面板会先按「全部」查一遍');
    assert.match(reader, /const \[filter, setFilter\] = useState\(boot\.filter\)/);
    assert.match(reader, /const \[query, setQuery\] = useState\(boot\.query\)/);
  });

  it('★ 恢复完立刻 return，这一轮不发请求', () => {
    const start = reader.indexOf("localStorage.setItem('npr.channel', channel)");
    const body = reader.slice(start, start + 1600);
    assert.match(body, /if \(saved\.filter !== filter \|\| saved\.query !== query\)/, '没比较就直接覆盖');
    assert.match(body, /setSearchOpen\(saved\.query !== ''\)[\s\S]{0,120}return;/,
      '恢复筛选后没 return —— 会先用旧值查一次、再被覆盖成第二次请求');
  });

  it('★ 写状态在发请求之前（写的就是这一轮真正用的值）', () => {
    const start = reader.indexOf("localStorage.setItem('npr.channel', channel)");
    const body = reader.slice(start, start + 1600);
    const saveAt = body.indexOf('saveChannelState(channel, { filter, query }');
    const loadAt = body.indexOf('void loadPage(undefined, true)');
    assert.ok(saveAt > 0 && loadAt > 0);
    assert.ok(saveAt < loadAt, '先查后写 —— 写进去的可能不是这次真正用的筛选');
  });

  it('★ 切频道不再把筛选 / 搜索词清成默认值', () => {
    const line = reader.slice(reader.indexOf('const selectChannel ='), reader.indexOf('const selectChannel =') + 400);
    assert.ok(!/setFilter\('all'\)/.test(line), 'selectChannel 还在清筛选 —— 切源必然丢掉状态');
    assert.ok(!/setQuery\(''\)/.test(line), 'selectChannel 还在清搜索词');
  });

  it('列表容器挂了 ref（记滚动位置要用）', () => {
    assert.match(reader, /className="npr-list" ref=\{listRef\}/);
  });

  it('★ 还有待还原的位置时不写盘（否则把 0 写进去）', () => {
    const start = reader.indexOf('saveChannelState(channel, { scroll: list.scrollTop }');
    assert.ok(start > 0, '找不到滚动保存');
    const before = reader.slice(Math.max(0, start - 400), start);
    assert.match(before, /if \(pendingListScroll\.current !== null\) return;/,
      '没挡「列表刚清空」的那一次写 —— 用户上次的位置会被 0 抹掉');
  });

  it('切频道前把最后一次滚动落下来（cleanup 里 flush）', () => {
    const start = reader.indexOf('const flush = () => {');
    const body = reader.slice(start, start + 1400);
    assert.match(body, /if \(timer !== 0\) \{ clearTimeout\(timer\); flush\(\); \}/,
      '切频道时没有 flush —— 最后那次滚动丢了');
  });
});
