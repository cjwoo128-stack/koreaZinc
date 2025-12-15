const { contextBridge, ipcRenderer } = require("electron");

// "window.api" 라는 객체를 웹 페이지(프론트엔드)에 노출시킵니다.
contextBridge.exposeInMainWorld("api", {
  // 인증
  login: (username, password) =>
    ipcRenderer.invoke("api:login", { username, password }),

  // 조회
  getStats: (params) => ipcRenderer.invoke("api:get-stats", params),
  getDevices: (params) => ipcRenderer.invoke("api:get-devices", params),
  getRecentData: (params) => ipcRenderer.invoke("api:get-recent-data", params),
  getRangeData: (params) => ipcRenderer.invoke("api:get-range-data", params),
  getChartData: (params) => ipcRenderer.invoke("api:get-chart-data", params),
  getAlerts: (token) => ipcRenderer.invoke("api:get-alerts", { token }),
  getThresholds: (params) => ipcRenderer.invoke("api:get-thresholds", params),

  // 기기 관리
  addDevice: (params) => ipcRenderer.invoke("api:add-device", params),
  deleteDevice: (params) => ipcRenderer.invoke("api:delete-device", params),

  // 설정 및 제어
  setLevels: (params) => ipcRenderer.invoke("api:set-levels", params),
  rebootDevice: (params) => ipcRenderer.invoke("api:reboot-device", params),
  syncConfig: (params) => ipcRenderer.invoke("api:sync-config", params),
  startPeriodicDataRequest: (params) =>
    ipcRenderer.invoke("api:start-periodic-data-request", params),
  stopPeriodicDataRequest: (params) =>
    ipcRenderer.invoke("api:stop-periodic-data-request", params),

  // 유틸리티
  openLogs: (params) => ipcRenderer.invoke("api:open-logs", params),
  exportZip: (params) => ipcRenderer.invoke("api:export-zip", params),
  updateModel: (params) => ipcRenderer.invoke("api:update-model", params),
  deleteAllImages: (params) =>
    ipcRenderer.invoke("api:delete-all-images", params),

  // [수정] Renderer가 준비되었음을 Main 프로세스에 알리는 신호
  rendererReady: () => ipcRenderer.send("renderer-ready"),

  // [추가] Main 프로세스로부터 신호를 수신하는 통로
  // [수정] 이제 데이터(initialData)를 함께 받습니다.
  onMainReady: (callback) =>
    ipcRenderer.on("main-ready", (event, initialData) => callback(initialData)),
});
