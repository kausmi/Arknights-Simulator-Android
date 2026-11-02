// 一级工作区始终占满可视区域；小窗口按完整布局等比适配。
export function createWorkspaceLayout(root, onResize) {
  let frame = 0;
  const layout = () => {
    const width = document.documentElement.clientWidth, height = window.innerHeight;
    // 只在「窗口本身就够大、但还没到设计基准 960x740」的桌面上做等比微缩，
    // 用来防止桌面小窗把布局撑溢出。手机横屏（~800x360）绝不能走这里：
    // zoom 会把所有 px 尺寸一起缩掉，12px 的操作文字变成 5~6px，地图格子点不中，
    // 看起来就「根本不是手机 UI」。手机交给 CSS 重排（.lv-stage 是 minmax(0,1fr)
    // + 侧栏定宽，本身就会自适应，不需要整体缩放）。
    const desktop = width >= 900 && height >= 620;
    const scale = desktop ? Math.min(1, width / 960, height / 740) : 1;
    root.style.zoom = String(scale);
    root.style.width = `${width / scale}px`;
    root.style.height = `${height / scale}px`;
    root.style.setProperty('--terminal-header-space', `${94 / scale}px`);
    root.style.setProperty('--terminal-footer-space', `${64 / scale}px`);
    onResize?.();
  };
  const resize = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(layout); };
  window.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('resize', resize);
  layout();
  return { resize, destroy() { cancelAnimationFrame(frame); window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize); } };
}

export function closePanel(button) { button.closest('dialog')?.close(); }
