/** Completely fictional data for the public interaction prototype. */
export const SAMPLE_TASK = {
  id: 'DEMO-001',
  title: '海边小镇场景搭建（演示）',
  category2: '场景制作',
  category3: '海岸主题',
  difficulty: 'D3',
  brief: [
    '这是用于展示数据单配置与供应商预览流程的虚构题目。请根据示意图制作一个海岸主题场景，包含街道、码头和一处交通节点。',
    '',
    '制作重点：让场景的空间层次清晰，主要路径可辨认，并保持统一的视觉风格。',
    '',
    '首轮制作时，请把下方示意图提供给 AI 作为输入，并在制作记录中说明参考图的使用方式。',
  ].join('\n'),
  acceptance: [
    '场景包含街道、码头和交通节点，布局清晰。',
    '主要视角可以查看完整场景，路径关系容易理解。',
    '首轮制作记录能证明已向 AI 提供示意参考图。',
    '提交可编辑工程文件和预览图。',
  ],
  references: [{
    name: '虚构场景示意图',
    note: '公开原型专用的生成图片，仅用于演示参考素材展示与首轮使用提醒。',
    sample: true,
  }],
  version: 1,
  assignment: {
    supplier: '示例供应商',
    taskVersion: 1,
    assignedAt: '2026-01-01T00:00:00.000Z',
  },
};

export const DEMO_ROWS = [
  ['DEMO-002', '校园入口场景（演示）', '校园与教育', 'D2'],
  ['DEMO-003', '室内展厅场景（演示）', '展馆与陈列', 'D1'],
  ['DEMO-004', '社区公园场景（演示）', '公共空间', 'D2'],
  ['DEMO-005', '城市街角场景（演示）', '城市空间', 'D3'],
  ['DEMO-006', '便利商店场景（演示）', '零售空间', 'D1'],
  ['DEMO-007', '科技教室场景（演示）', '教学空间', 'D2'],
  ['DEMO-008', '乡村庭院场景（演示）', '居住空间', 'D2'],
  ['DEMO-009', '交通换乘区场景（演示）', '交通设施', 'D3'],
].map(([id, title, category3, difficulty]) => ({
  id, title, category2: '静态场景', category3, difficulty,
  brief: '制作' + title + '。这是虚构题目，用于展示数据单字段。',
  acceptance: ['场景体现' + title + '的主要结构。'],
  references: [], version: 1, assignment: null,
}));
