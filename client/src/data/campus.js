/**
 * 校园地图 · 大厅层的关卡选择（全局世界地图版）
 *
 * 背景是一整张手绘夜色插画（public/assets/world-map.png，1080×664，世界坐标 = 图内坐标 ×2）。
 * 没有节点圆圈 —— 七段记忆对应插画里的七个地标，两个小家伙手牵手走到地标旁按 Enter 进入。
 *
 * built = 这一关是否已经做完。没做完的地标进不去，避免她点进去看到空关卡。
 */

export const CAMPUS = {
  /** 世界尺寸 = 插画 1080×664 × 2 */
  width: 2160,
  height: 1328,

  /** 地标中心（图内坐标 ×2，对着插画里的实际位置标定） */
  nodes: [
    {
      id: 'level01',
      x: 230,
      y: 1040,
      where: '操场',
      title: '操场 · UNO',
      line: '一切从一副 UNO 开始',
      built: true,
    },
    {
      id: 'level02',
      x: 580,
      y: 896,
      where: '挑战杯',
      title: '聊到快门禁',
      line: '第一次发现能聊这么久',
      built: true,
    },
    {
      id: 'level03',
      x: 924,
      y: 590,
      where: '网球场',
      title: '两遍课',
      line: '16 周，我上了 32 遍',
      built: true,
    },
    {
      id: 'level04',
      x: 1024,
      y: 864,
      where: '路灯下',
      title: '电动车的夜路',
      line: '每次开课前我都去接你',
      built: true,
    },
    {
      id: 'level05',
      x: 1170,
      y: 1010,
      where: '快递站',
      title: '那场雨',
      line: '你在背后替我挡雨',
      built: true,
    },
    {
      id: 'level06',
      x: 1400,
      y: 750,
      where: '餐厅',
      title: '那晚',
      line: '只有我们两个人知道',
      built: true,
    },
    {
      id: 'level07',
      x: 1670,
      y: 340,
      where: '西区体育场',
      title: '玫瑰',
      line: '花不在屏幕里',
      built: true,
    },
  ],
};

/** 起点与终点的显示信息 */
export const CAMPUS_END = {
  where: '终点',
  title: '那封信',
  line: '集齐七段记忆才打得开',
};

export const TOTAL_NODES = CAMPUS.nodes.length;
