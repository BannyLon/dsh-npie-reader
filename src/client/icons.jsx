/**
 * Minimal lucide-style icon set for the reader. Stroke geometry follows the
 * lucide 24x24 outline grid, so the UI keeps a consistent look without taking
 * a runtime dependency on an icon package — every path is inlined here and
 * bundled into lib/client.js.
 *
 * Naming: icon names are kebab-case and match the lucide names they mirror.
 */
const PATHS = {
  'arrow-up-right': ['M7 7h10v10', 'M7 17 17 7'],
  'book-open': ['M12 7v14', 'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z'],
  bookmark: ['m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z'],
  /* lucide `calendar`。日记那个 tab 用它 —— 用 `file-text` 会和「文章」撞语义，
     用户会以为第三个 tab 是「另一份订阅列表」。 */
  calendar: ['M8 2v4', 'M16 2v4', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'M3 10h18'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'chevron-left': ['m15 18-6-6 6-6'],
  'chevron-right': ['m9 18 6-6-6-6'],
  'chevron-up': ['m18 15-6-6-6 6'],
  circle: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20'],
  /* lucide `clock`。侧栏一级视图切换器「按时间」用它。
     ★ 不复用 `calendar`：`calendar` 已经是日记 tab 的图标，同一个图标在一屏里
       指两件事，用户会以为切换器和 tab 是同一层东西。 */
  clock: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20', 'M12 6v6l4 2'],
  /* lucide `tag`。区块标题「标签」用它 —— 标题要「立起来」就靠前置图标 + 字重。 */
  tag: ['M12.6 2.6a2 2 0 0 0-1.4-.6H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.4 8.4a2 2 0 0 0 2.8 0l7.2-7.2a2 2 0 0 0 0-2.8Z', 'M7 7h.01'],
  'circle-check': ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20', 'm9 12 2 2 4-4'],
  copy: ['M8 8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2Z', 'M4 16a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  ellipsis: ['M12 12h.01', 'M19 12h.01', 'M5 12h.01'],
  'eye-off': ['M10.7 5.1A10.9 10.9 0 0 1 12 5c7 0 10 7 10 7a17.6 17.6 0 0 1-3 4.2', 'M6.6 6.6A17.6 17.6 0 0 0 2 12s3 7 10 7a10.9 10.9 0 0 0 5.4-1.4', 'M14.1 14.1a3 3 0 1 1-4.2-4.2', 'm2 2 20 20'],
  'file-check': ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v5h6', 'm9 15 2 2 4-4'],
  /* 两个**自定义**名字（不在 lucide 里）：阅读器的两档缩放基准要能一眼分开 ——
     横着一个双向箭头 = 按宽度铺满；四角框 = 整页装进窗口。
     复用 `minus` / `monitor` 的话，用户会以为「适宽」是缩小、「适应窗口」是投屏。 */
  'fit-width': ['M3 12h18', 'M7 8l-4 4 4 4', 'M17 8l4 4-4 4'],
  'fit-page': ['M3 8V5a2 2 0 0 1 2-2h3', 'M16 3h3a2 2 0 0 1 2 2v3', 'M21 16v3a2 2 0 0 1-2 2h-3', 'M8 21H5a2 2 0 0 1-2-2v-3'],
  'file-text': ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v5h6', 'M8 13h8', 'M8 17h5'],
  folder: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'],
  globe: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20', 'M2 12h20', 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z'],
  highlighter: ['M16 3l5 5-9 9H7v-5z', 'M4 21h10'],
  info: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20', 'M12 16v-4', 'M12 8h.01'],
  'layers-3': ['M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z', 'm22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65', 'm22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65'],
  'maximize': ['M8 3H5a2 2 0 0 0-2 2v3', 'M21 8V5a2 2 0 0 0-2-2h-3', 'M3 16v3a2 2 0 0 0 2 2h3', 'M16 21h3a2 2 0 0 0 2-2v-3'],
  'minimize': ['M8 3v3a2 2 0 0 1-2 2H3', 'M21 8h-3a2 2 0 0 1-2-2V3', 'M3 16h3a2 2 0 0 1 2 2v3', 'M16 21v-3a2 2 0 0 1 2-2h3'],
  minus: ['M5 12h14'],
  monitor: ['M2 5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z', 'M8 21h8', 'M12 17v4'],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'],
  'panel-left-close': ['M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M9 3v18', 'm16 15-3-3 3-3'],
  'panel-left-open': ['M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M9 3v18', 'm14 9 3 3-3 3'],
  /* lucide `pause` / `play`。朗读按钮用。
     ★ pause 用两条竖线而不是两个空心矩形：整套图标是描边风格，空心矩形在 15px
       下会糊成一个「日」字，认不出是暂停。 */
  pause: ['M9 4v16', 'M15 4v16'],
  play: ['m7 4 13 8-13 8Z'],
  pencil: ['M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z', 'm15 5 4 4'],
  plus: ['M12 5v14', 'M5 12h14'],
  podcast: ['M12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M16.85 18.58a9 9 0 1 0-9.7 0', 'M8 14a5 5 0 1 1 8 0', 'M10 20a1 1 0 0 1-1-1v-1a2 2 0 1 1 4 0v1a1 1 0 0 1-1 1Z'],
  'refresh-cw': ['M3 12a9 9 0 0 1 15.5-6.2L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-15.5 6.2L3 16', 'M3 21v-5h5'],
  rss: ['M4 11a9 9 0 0 1 9 9', 'M4 4a16 16 0 0 1 16 16', 'M6 19a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z'],
  search: ['M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16', 'm21 21-4.3-4.3'],
  settings: ['M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
  sparkles: ['M9.9 2.6 11.4 7l4.4 1.5-4.4 1.5-1.5 4.4-1.5-4.4L4 8.5 8.4 7Z', 'M18 5.5l.9 2.5 2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9Z'],
  sun: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8', 'M12 2v2', 'M12 20v2', 'm4.93 4.93 1.41 1.41', 'm17.66 17.66 1.41 1.41', 'M2 12h2', 'M20 12h2', 'm6.34 17.66-1.41 1.41', 'm19.07 4.93-1.41 1.41'],
  'trash-2': ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M10 11v6', 'M14 11v6'],
  type: ['M4 7V4h16v3', 'M9 20h6', 'M12 4v16'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  'wand-sparkles': [
    'm21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72',
    'm14 7 3 3',
    'M5 6v4',
    'M19 14v4',
    'M10 2v2',
    'M7 8H3',
    'M21 16h-4',
    'M11 3H9',
  ],
  x: ['M18 6 6 18', 'M6 6l12 12'],
};

/**
 * Render one icon.
 * @param {{name: string, size?: number, strokeWidth?: number, className?: string}} props
 */
export function Icon({ name, size = 17, className, strokeWidth = 1.7, ...rest }) {
  const paths = PATHS[name] ?? PATHS.circle;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true" focusable="false" {...rest}>
      {paths.map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

/** True when the icon set actually defines this name (fallback is not counted). */
export function hasIcon(name) {
  return Object.hasOwn(PATHS, name);
}

export { PATHS as ICON_PATHS };
