// =====================================================
// 전역 변수 및 상태
// =====================================================
let authToken = null;
let currentUser = null;
let chart = null;
let updateInterval = null;
let chartRange = 60; // 기본 1시간
let devices = []; // 서버에서 가져온 기기 목록을 저장하는 배열

//[추가] 현재 선택된 기기 정보
let currentDeviceId = null;
let currentDeviceIP = null;

// [추가] 현재 선택된 기기의 임계값 정보
let currentThresholds = null;

// =====================================================
// 인증 및 페이지 관리
// =====================================================

// 로그인 폼 제출
document.getElementById("loginForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const username = document.getElementById("username").value;
  const password = document.getElementById("password").value;
  const loginError = document.getElementById("loginError");
  const loginBtnText = document.getElementById("loginBtnText");
  const loginLoading = document.getElementById("loginLoading"); // 로딩 표시

  loginBtnText.style.display = "none";
  loginLoading.style.display = "inline-block";
  loginError.style.display = "none";

  try {
    // fetch 대신 window.api를 사용
    const data = await window.api.login(username, password);

    if (data) {
      authToken = data.access_token;
      currentUser = data.username; // 로컬 스토리지에 저장

      localStorage.setItem("authToken", authToken);
      localStorage.setItem("currentUser", currentUser); // 대시보드로 전환

      showDashboard();

      // [수정] 로그인 성공 후 대시보드 초기화 로직을 반드시 호출해야 합니다.
      // 이 함수가 호출되어야 차트가 그려지고 데이터 갱신이 시작됩니다.
      updateDeviceListUI();
      await initDashboard();
    }
  } catch (error) {
    console.error("로그인 오류:", error);
    loginError.textContent = getCleanErrorMessage(error);
    loginError.style.display = "block";
  } finally {
    loginBtnText.style.display = "inline";
    loginLoading.style.display = "none";
  }
});

// 로그아웃
async function logout() {
  // [수정] 로그아웃 시 실행 중인 모든 주기적 요청을 중지하도록 메인 프로세스에 알립니다.
  if (authToken) {
    try {
      await window.api.stopPeriodicDataRequest({ token: authToken });
    } catch (error) {
      console.error("Failed to stop periodic requests on logout:", error);
    }
  }

  authToken = null;
  currentUser = null;
  localStorage.removeItem("authToken");
  localStorage.removeItem("currentUser");
  localStorage.removeItem("currentDeviceId"); // 현재 선택 기기 상태도 초기화
  localStorage.removeItem("currentDeviceIP");

  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }

  document.getElementById("dashboard").classList.remove("active");
  document.getElementById("loginPage").style.display = "flex";
}

// [수정] 대시보드 표시 로직 변경
function showDashboard() {
  document.getElementById("loginPage").style.display = "none";
  document.getElementById("dashboard").classList.add("active");
  document.getElementById("currentUser").textContent = currentUser; // 대시보드 초기화
}

// 페이지 로드시 토큰 확인
window.addEventListener("DOMContentLoaded", () => {
  // [수정] Main 프로세스에 프론트엔드가 준비되었음을 먼저 알립니다.
  // Main 프로세스에 프론트엔드가 준비되었음을 알립니다.
  window.api.rendererReady();

  // [수정] Main 프로세스로부터 '준비 완료' 신호를 받으면 대시보드를 초기화합니다.
  window.api.onMainReady(async (initialData) => {
    console.log("Main process is ready. Initializing dashboard.");
    // [수정] 앱 시작 시 자동 로그인을 제거하고, 로그인 화면을 항상 표시합니다.
    // Main 프로세스로부터 받은 초기 기기 목록은 로그인 성공 후 사용하기 위해 전역 변수에 저장해 둡니다.
    devices = initialData.devices || [];

    // 만약 이전 토큰이 남아있다면 모두 삭제하여 완전한 로그아웃 상태를 보장합니다.
    await logout();
  });
});

// =====================================================
// API 호출 래퍼 및 유틸리티
// =====================================================

/**
 * Electron IPC 오류 메시지에서 "Error invoking remote method..." 접두사를 제거합니다.
 * @param {Error} error - catch 블록에서 받은 오류 객체
 * @returns {string} - 정리된 오류 메시지
 */
function getCleanErrorMessage(error) {
  if (error && error.message) {
    const prefix = "Error invoking remote method";
    return error.message.startsWith(prefix)
      ? error.message.substring(error.message.indexOf(":") + 2)
      : error.message;
  }
  return "알 수 없는 오류가 발생했습니다.";
}
// =====================================================
// 데이터 로딩 (백엔드 API 호출)
// =====================================================

// [추가] 모든 데이터 표시 영역을 초기화하는 함수
function clearAllData() {
  // 통계 초기화
  updateStatsUI({
    total_inspections: 0,
    good_count: 0,
    defect_count: 0,
    operation_rate: 0.0,
    alert_threshold: 60, // 기본 임계값
    current_defect_rate: 0.0,
  });
  // 차트 초기화
  updateChart({ data: [], threshold: 60 });
  // 최근 데이터 테이블 초기화
  updateDataTable([]);
}

// [추가] 현재 기기의 임계값 설정을 가져오는 함수
async function fetchThresholds() {
  if (!currentDeviceIP) {
    currentThresholds = null;
    return;
  }
  try {
    // API를 통해 현재 기기의 임계값들을 가져옵니다.
    const thresholds = await window.api.getThresholds({
      token: authToken,
      device_ip: currentDeviceIP,
    });
    currentThresholds = thresholds;
    console.log(
      "--- Warning Threshold (currentThresholds.warning):",
      currentThresholds.warning
    ); // [추가] Warning 임계값 로그
    console.log("임계값 정보 업데이트:", currentThresholds);
  } catch (error) {
    console.error("임계값 불러오기 오류:", error);
    currentThresholds = null; // 실패 시 초기화
  }
}

// 통계 데이터 가져오기 (기기 필터링 적용)
async function fetchStats() {
  try {
    const data = await window.api.getStats({
      token: authToken,
      device_ip: currentDeviceIP,
    });
    updateStatsUI(data);
    checkAlerts(data);
  } catch (error) {
    console.error("통계 데이터 오류:", error);
  }
}

// 최근 검사 데이터 가져오기 (기기 필터링 적용)
async function fetchRecentData() {
  try {
    console.log(`[fetchRecentData] Fetching for device_ip: ${currentDeviceIP}`);
    const data = await window.api.getRecentData({
      token: authToken,
      minutes: 10,
      device_ip: currentDeviceIP,
    });
    console.log("[fetchRecentData] Received data from API:", JSON.stringify(data, null, 2)); // Add JSON.stringify for better logging

    let dataForTable = [];
    if (data && Array.isArray(data.data)) {
      // Expected format: { data: [...] }
      dataForTable = data.data;
    } else if (data && Array.isArray(data)) {
      // If response is directly an array: [...]
      dataForTable = data;
    } else if (data && typeof data === 'object' && data.datetime && data.confidence !== undefined) {
      // If response is a single object (like the RAW DATA example)
      dataForTable = [data];
    } else {
        console.error(
            '[fetchRecentData] Unexpected data structure received from API:',
            data
        );
    }
    updateDataTable(dataForTable);
  } catch (error) {
    console.error("최근 데이터 오류:", error);
    updateDataTable([]); // 오류 발생 시에도 빈 배열로 테이블 업데이트
  }
}

// =====================================================
// UI 업데이트
// =====================================================

// 통계 UI 업데이트
function updateStatsUI(stats) {
  document.getElementById("totalInspections").textContent =
    stats.total_inspections.toLocaleString();
  document.getElementById("goodCount").textContent =
    stats.good_count.toLocaleString();
  document.getElementById("defectCount").textContent =
    stats.defect_count.toLocaleString();
  document.getElementById("operationRate").textContent =
    stats.operation_rate.toFixed(1);

  const total = stats.total_inspections;
  const goodRate =
    total > 0 ? ((stats.good_count / total) * 100).toFixed(1) : 0;
  const defectRate =
    total > 0 ? ((stats.defect_count / total) * 100).toFixed(1) : 0;

  document.getElementById("goodRate").textContent = goodRate;
  document.getElementById("defectRate").textContent = defectRate;
} // 알람 배너 표시/숨김 처리

// 알람 확인
function checkAlerts(stats) {
  const alertBanner = document.getElementById("alertBanner");
  const alertMessage = document.getElementById("alertMessage");

  // [추가] stats.levels.warning이 유효한 숫자인지 확인
  const warningThresholdForAlert =
    stats.levels &&
    typeof stats.levels.warning !== "undefined" &&
    !isNaN(stats.levels.warning)
      ? parseFloat(stats.levels.warning)
      : null;

  console.log(
    `[checkAlerts] Current Defect Rate: ${stats.current_defect_rate.toFixed(
      1
    )}%, Warning Threshold (stats.levels.warning): ${
      warningThresholdForAlert !== null
        ? warningThresholdForAlert.toFixed(1) + "%"
        : "N/A"
    }`
  );
  console.log(
    `[checkAlerts] Condition: current_defect_rate (${stats.current_defect_rate.toFixed(
      1
    )}%) >= Warning Threshold (${
      warningThresholdForAlert !== null
        ? warningThresholdForAlert.toFixed(1) + "%"
        : "N/A"
    }) is ${
      warningThresholdForAlert !== null &&
      stats.current_defect_rate >= warningThresholdForAlert
    }`
  );

  if (
    warningThresholdForAlert !== null &&
    stats.current_defect_rate >= warningThresholdForAlert
  ) {
    alertMessage.textContent = ` 주의: 불량률이 임계값을 초과했습니다! (현재: ${stats.current_defect_rate.toFixed(
      1
    )}%, 임계값: ${warningThresholdForAlert.toFixed(1)}%)`;
    alertBanner.classList.add("active");

    const alarmSound = document.getElementById("alarmSound");
    if (alarmSound && alarmSound.paused) {
      alarmSound.play().catch(e => console.error("오디오 재생 실패:", e));
    }
  } else {
    alertBanner.classList.remove("active");

    const alarmSound = document.getElementById("alarmSound");
    if (alarmSound && !alarmSound.paused) {
      alarmSound.pause();
      alarmSound.currentTime = 0;
    }
  }
}
// 차트 객체 초기 생성
function initChart() {
  const canvas = document.getElementById("chartCanvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  if (chart) chart.destroy(); // 기존 차트가 있으면 파괴

  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "불량률", // [변경] "신뢰도 (Confidence)"를 "불량률"로 변경
          data: [],
          borderColor: "#00ff88",
          backgroundColor: "rgba(0, 255, 136, 0.1)",
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointBackgroundColor: "#00ff88",
          // 데이터셋 자체의 포인트 스타일은 원형 유지 (차트상의 점)
          // [수정] 데이터 포인트가 하나만 있을 때 선이 전체로 이어지는 것을 방지합니다.
          // 데이터가 부족할 경우(예: 1개) 선을 그리지 않고 점만 표시합니다.
          spanGaps: false,
          pointStyle: "circle",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        // 범례(Legend) 커스터마이징
        legend: {
          labels: {
            color: "#e8e8e8",
            usePointStyle: true,
            generateLabels: function (chart) {
              const original =
                Chart.defaults.plugins.legend.labels.generateLabels(chart);
              original.forEach((label) => {
                label.pointStyle = "line";
                label.lineWidth = 2;
              });
              return [...original];
            },
          },
          onClick: function (e, legendItem, legend) {
            const index = legendItem.datasetIndex;
            const ci = legend.chart;
            if (ci.isDatasetVisible(index)) {
              ci.hide(index);
              legendItem.hidden = true;
            } else {
              ci.show(index);
              legendItem.hidden = false;
            }
          },
        },
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: {
            label: function (context) {
              return context.dataset.label + ": " + context.parsed.y + "%";
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(255, 255, 255, 0.05)" },
          ticks: { color: "#a8a8a8", maxRotation: 0, autoSkip: true },
        },
        y: {
          min: 0,
          max: 100,
          beginAtZero: true,
          grid: { color: "rgba(255, 255, 255, 0.05)" },
          ticks: {
            color: "#a8a8a8",
            stepSize: 20,
            callback: (val) => val + "%",
          },
        },
      },
    },
  });
}

/**
 * 차트의 데이터 조회 기간(1시간, 3시간, 6시간)을 변경하고 데이터를 새로고침합니다.
 * @param {number} minutes - 설정할 기간 (분 단위: 60, 180, 360 등)
 */
function updateChartRange(minutes) {
  if (chartRange === minutes) {
    return;
  }

  chartRange = minutes;

  // UI 버튼의 활성화 상태(active 클래스)를 업데이트합니다.
  // HTML 구조가 ".chart-controls .btn" 형태이므로 이 선택자를 사용합니다.
  document.querySelectorAll(".chart-controls .btn").forEach((btn) => {
    btn.classList.remove("active");

    // 버튼의 onclick 속성 값을 비교하여 현재 클릭된 버튼을 활성화합니다.
    if (btn.getAttribute("onclick") === `updateChartRange(${minutes})`) {
      btn.classList.add("active");
    }
  });

  // 핵심: 새로운 기간으로 차트 데이터 요청
  fetchChartData();
  console.log(
    `차트 기간이 ${minutes}분으로 변경되었습니다. 데이터를 새로고침합니다.`
  );
}

// 차트 데이터 업데이트
function updateChart(responseData) {
  if (!chart) {
    console.error("차트 객체가 초기화되지 않아 업데이트를 중단합니다.");
    return;
  }

  const chartData = responseData.data || [];

  if (!chartData || chartData.length === 0) {
    console.warn("서버에서 받은 차트 데이터 배열이 비어 있습니다.");
    chart.data.labels = [];
    chart.data.datasets[0].data = [];
  } else {
    const labels = chartData.map((d) => {
      const date = new Date(d.time);
      return date.toLocaleTimeString("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    });

    const confidenceData = chartData.map((d) => {
      return parseFloat(d.confidence) || 0;
    });

    chart.data.labels = labels;
    chart.data.datasets[0].data = confidenceData;
  }

  chart.update("none");
}

// 차트 데이터 가져오기 (기기 필터링 적용)
async function fetchChartData() {
  try {
    // [수정] 올바른 API(getChartData)와 파라미터를 사용하도록 변경
    const result = await window.api.getChartData({
      token: authToken,
      minutes: chartRange,
      device_ip: currentDeviceIP,
    });
    updateChart(result);
  } catch (error) {
    console.error("차트 데이터 로딩 오류:", error);
  }
}

// 최근 검사 데이터 테이블 업데이트
function updateDataTable(data) {
  const tbody = document.getElementById("dataTableBody");

  if (!data || data.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="3" style="text-align: center; color: var(--text-secondary);">데이터가 없습니다</td></tr>';
    return;
  }

  // [수정] timestamp를 기준으로 중복된 데이터를 제거합니다.
  const uniqueData = Array.from(
    new Map(data.map((item) => [item.timestamp, item])).values()
  );

  // 최근 10개만 표시
  const recentData = uniqueData.slice(-10).reverse();

  tbody.innerHTML = recentData
    .map((item) => {
      // [수정] UTC 시간을 KST(한국 표준시)로 변환하여 표시합니다.
      const time = new Date(item.timestamp).toLocaleTimeString("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

      let badgeClass;
      let badgeText;

      // [수정] 서버에서 판정한 'result' 값을 직접 사용하여 UI에 반영
      const isNormal = item.result === "normal";

      if (isNormal) {
        badgeClass = "badge-success";
        badgeText = "양호";
      } else {
        badgeClass = "badge-danger";
        badgeText = "필터 손상 의심";
      }

      return `
                <tr>
                    <td>${time}</td>
                    <td><span class="badge ${badgeClass}">${badgeText}</span></td>
                    <td>${(item.confidence * 100).toFixed(1)}%</td>
                </tr>
            `;
    })
    .join("");
}

// =====================================================
// 제어 및 설정 기능
// =====================================================

// 알람 임계값 설정 업데이트 (기기 필터링 적용)
async function updateThreshold() {
  const inputEl = document.getElementById("thresholdInput");
  const threshold = parseFloat(inputEl.value);

  if (!currentDeviceIP) {
    alert("먼저 제어할 기기를 선택해주세요.");
    return;
  }

  // 유효성 검사 (0~100 사이)
  if (isNaN(threshold) || threshold < 0 || threshold > 100) {
    alert("0에서 100 사이의 유효한 숫자를 입력해주세요.");
    return;
  }

  const btn = document.querySelector("button[onclick='updateThreshold()']");
  try {
    // [수정] setThreshold API 호출
    const result = await window.api.setThreshold({
      token: authToken,
      threshold: threshold,
      device_ip: currentDeviceIP,
    });
    alert(
      `알람 임계값이 ${currentDeviceId} 기기에 대해 ${threshold}%로 설정되었습니다.`
    );
  } catch (error) {
    console.error("임계값 업데이트 오류:", error);
    alert(`임계값 업데이트 실패: ${getCleanErrorMessage(error)}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
  // [추가] 임계값 변경 후 데이터 새로고침
  fetchThresholds();
  fetchStats();
  fetchChartData();
}

// 데이터 내보내기 (ZIP) 버튼 이벤트 리스너
document
  .getElementById("exportCompressedDataBtn")
  ?.addEventListener("click", async () => {
    const startTime = document.getElementById("exportStartTime").value;
    const endTime = new Date().toISOString(); // 종료 시간은 현재 시간으로 고정

    // currentDeviceIP, currentDeviceId 변수가 전역적으로 정의되어 있다고 가정
    // 서버의 export_zip 엔드포인트는 device_ip를 받습니다.
    const btn = document.getElementById("exportCompressedDataBtn");
    const originalBtnHTML = btn.innerHTML;

    // 유효성 검사
    if (!startTime) {
      alert("시작 시간을 선택해주세요.");
      return;
    }
    if (!currentDeviceIP) {
      alert("먼저 데이터를 내보낼 기기를 선택해주세요.");
      return;
    }

    btn.disabled = true;
    btn.innerHTML = `<span class="loading"></span>&nbsp; <span>ZIP 생성 및 다운로드 중...</span>`;

    try {
      const { filePath } = await window.api.exportZip({
        token: authToken,
        start_time: startTime,
        end_time: endTime,
        device_ip: currentDeviceIP,
      });

      // [수정] Main 프로세스에서 파일을 직접 저장하고, 결과(성공 여부)만 받습니다.
      // 이제 사용자는 '다른 이름으로 저장' 대화상자를 통해 파일을 저장하게 됩니다.
      if (filePath) {
        alert(`데이터를 성공적으로 내보냈습니다.\n저장된 위치: ${filePath}`);
      } else {
        // 사용자가 저장을 취소한 경우
        console.log("데이터 내보내기가 사용자에 의해 취소되었습니다.");
      }
    } catch (error) {
      console.error("데이터 내보내기 오류:", error);
      alert(`데이터 내보내기 실패: ${getCleanErrorMessage(error)}`);
    } finally {
      // 버튼을 원래 상태로 복원
      btn.disabled = false;
      btn.innerHTML = originalBtnHTML;
    }
  });
// =====================================================
// 기기(Device) 관리
// =====================================================

/**
 * 현재 선택된 기기 ID와 IP를 브라우저의 로컬 스토리지에 저장합니다.
 * 페이지를 새로고침해도 마지막 선택 상태가 유지됩니다.
 *
 * 참고: 기기 '목록' 자체는 서버에서 가져오므로 로컬에 저장하지 않습니다.
 * 오직 '선택 상태'만 저장합니다.
 */

// 현재 선택 기기 상태 로컬 스토리지에 저장
function saveCurrentDeviceState() {
  localStorage.setItem("currentDeviceId", currentDeviceId);
  localStorage.setItem("currentDeviceIP", currentDeviceIP);
}

// 로컬 스토리지에서 마지막으로 선택했던 기기 상태를 불러옵니다.
function loadCurrentDeviceState() {
  const savedId = localStorage.getItem("currentDeviceId");
  const savedIp = localStorage.getItem("currentDeviceIP");

  if (savedId && savedIp) {
    currentDeviceId = savedId;
    currentDeviceIP = savedIp;
    return true;
  }
  return false;
}

// '등록된 기기 목록' 테이블 UI를 업데이트합니다.
function updateDeviceListUI() {
  const tbody = document.getElementById("deviceListBody");

  if (!tbody) return;

  if (devices.length === 0) {
    tbody.innerHTML = `
            <tr>
                <td colspan="3" style="text-align: center; color: var(--text-secondary);">
                    등록된 기기가 없습니다.
                </td>
            </tr>
        `;
    return;
  }

  tbody.innerHTML = devices
    .map((device, index) => {
      const isSelected = device.ip === currentDeviceIP;

      return `
                <tr class="${
                  isSelected ? "selected-row" : ""
                }" onclick="selectDevice(${index})">
                    <td>${device.name}</td>
                    <td>${device.ip}</td>
                    <td style="text-align: center;">
                        <button 
                            class="btn-delete" 
                            onclick="event.stopPropagation(); deleteDevice(${index})" 
                            title="삭제"
                        >
                            <i class="fas fa-trash-alt"></i>
                        </button>
                    </td>
                </tr>
            `;
    })
    .join("");
}

/**
 * 특정 기기를 선택하거나 선택을 해제하고, 관련 상태와 UI를 모두 업데이트하는 핵심 함수.
 * @param {number} index - 전역 'devices' 배열에서 선택할 기기의 인덱스. -1을 주면 선택 해제.
 */
async function selectDevice(index) {
  // 1. 모든 기존 데이터 요청 중지 (주기적 요청 포함)
  if (updateInterval) clearInterval(updateInterval);
  if (authToken) {
    await window.api.stopPeriodicDataRequest({ token: authToken });
  }

  // 2. 기기 선택 또는 해제
  if (index >= 0 && index < devices.length) {
    // --- 기기 선택 ---
    const selectedDevice = devices[index];
    currentDeviceId = selectedDevice.name;
    currentDeviceIP = selectedDevice.ip;

    // UI 즉시 업데이트
    saveCurrentDeviceState();
    updateDeviceListUI();
    populateDeviceDropdown();

    // 새로운 기기에 대한 데이터 요청 시작
    await window.api.startPeriodicDataRequest({
      token: authToken,
      device_ip: currentDeviceIP,
    });

    // 선택된 기기에 대한 최신 데이터 즉시 로드
    fetchThresholds().then(() => {
      fetchStats();
      fetchChartData();
      fetchRecentData();
      updateVideoFeedURL();
    });

    // UI 갱신을 위한 프론트엔드 인터벌 재시작
    updateInterval = setInterval(() => {
      if (currentDeviceIP) {
        fetchStats();
        fetchChartData();
        fetchRecentData();
      }
    }, 5000);
  } else {
    // --- 기기 선택 해제 ---
    currentDeviceId = null;
    currentDeviceIP = null;
    currentThresholds = null;
    saveCurrentDeviceState();

    // UI 클리어 및 업데이트
    clearAllData();
    updateDeviceListUI();
    populateDeviceDropdown();
    updateVideoFeedURL(); // 비디오 피드를 플레이스홀더로 리셋
  }
}

/**
 * 헤더의 기기 선택 드롭다운 메뉴를 채우고 현재 선택된 기기를 표시합니다.
 */
function populateDeviceDropdown() {
  const deviceSelector = document.getElementById("deviceSelector");
  const currentDeviceStatus = document.getElementById("currentDeviceStatus");

  if (!deviceSelector) return;

  deviceSelector.innerHTML = '<option value="">기기를 선택하세요</option>'; // 기본 옵션

  devices.forEach((device) => {
    const option = document.createElement("option");
    option.value = device.name;
    option.textContent = `${device.name} (${device.ip})`;
    deviceSelector.appendChild(option);
  });

  // 현재 선택된 기기가 있으면 드롭다운에 반영
  if (currentDeviceId) {
    deviceSelector.value = currentDeviceId;
    if (currentDeviceStatus) {
      currentDeviceStatus.classList.add("active"); // 연결됨 상태
    }
  } else {
    deviceSelector.value = ""; // "기기를 선택하세요" 선택
    if (currentDeviceStatus) {
      currentDeviceStatus.classList.remove("active"); // 연결 끊김 상태
    }
  }

  // 드롭다운이 업데이트될 때 비디오 피드 URL도 업데이트
  if (currentDeviceId || currentDeviceIP) {
    updateVideoFeedURL();
  } else {
    document.getElementById("videoFeed").src = "placeholder_video.png"; // 상대 경로로 수정
  }
}

/**
 * 실시간 영상(Video Feed)의 URL을 현재 선택된 기기에 맞게 업데이트합니다.
 */
async function updateVideoFeedURL() {
  const videoFeed = document.getElementById("videoFeed");
  if (!videoFeed) return;

  const setVideoStatus = (status, message) => {
    const indicator = document.getElementById("videoStatusIndicator");
    const text = document.getElementById("videoStatusText");
    if (indicator && text) {
      indicator.className = "status-indicator";
      indicator.classList.add(status);
      text.textContent = message;
    }
  };

  // 기존 Blob URL 해제
  if (videoFeed.src.startsWith("blob:")) URL.revokeObjectURL(videoFeed.src);

  // 기기가 선택되지 않았을 경우, 플레이스홀더를 표시하고 함수를 종료합니다.
  if (!currentDeviceIP) {
    setVideoStatus("danger", "기기를 선택하세요");
    videoFeed.src = "placeholder_video.png"; // 상대 경로로 수정
    return;
  }

  // 1. 로딩 상태를 즉시 표시
  setVideoStatus("warning", "영상 연결 중...");

  // 2. 캐시 방지를 위해 타임스탬프를 포함한 비디오 URL을 생성
  const timestamp = new Date().getTime();

  // 3. [수정] Electron 프록시를 거치지 않고, 엣지 기기의 비디오 스트림 URL로 직접 요청합니다.
  // currentDeviceIP에 '192.168.10.31:8000'과 같이 포트가 포함되어 있다고 가정합니다.
  videoFeed.src = `http://${currentDeviceIP}/api/v1/video-feed?_t=${encodeURIComponent(
    currentDeviceIP
  )}&_t=${timestamp}`;

  // 4. 스트림이 성공적으로 시작되면(첫 프레임 수신), onload 이벤트가 발생
  videoFeed.onload = () => {
    if (videoFeed.src.includes("placeholder_video.png")) {
      setVideoStatus("danger", "영상 연결 실패");
    } else {
      setVideoStatus("success", "실시간 스트리밍 활성화");
    }
  };

  // 5. 네트워크 오류 등으로 스트림 로드에 실패하면 onerror 이벤트가 발생
  videoFeed.onerror = () => {
    console.error("비디오 스트림 로드 실패:", videoFeed.src);
    setVideoStatus("danger", "영상 연결 실패 (네트워크 오류)");
    videoFeed.onerror = null; // 이벤트 핸들러를 제거하여 무한 루프 방지
    videoFeed.src = "placeholder_video.png"; // 상대 경로로 수정
  };
}

/**
 * 헤더의 드롭다운 메뉴에서 기기를 변경했을 때 호출되는 이벤트 핸들러.
 * @param {string} deviceName - 선택된 기기의 이름
 */
async function switchDevice(deviceName) {
  if (deviceName) {
    const index = devices.findIndex((d) => d.name === deviceName);
    if (index !== -1) {
      await selectDevice(index); // 기기 선택
    } else {
      console.error("선택된 기기를 찾을 수 없습니다:", deviceName);
      await selectDevice(-1); // 기기를 찾지 못하면 선택 해제
    }
  } else {
    await selectDevice(-1); // 기기 선택 해제
  }
}

// '기기 추가' 모달에서 폼을 제출했을 때의 이벤트 핸들러.
document
  .getElementById("addDeviceForm")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const deviceName = document.getElementById("deviceName").value.trim();
    const deviceIP = document.getElementById("deviceIP").value.trim();

    try {
      await window.api.addDevice({
        token: authToken,
        name: deviceName,
        ip: deviceIP,
      });

      // 서버에서 최신 기기 목록을 다시 불러와 UI를 갱신합니다.
      // [수정] fetchDevicesFromAPI 대신 직접 목록을 다시 가져옵니다.
      const updatedDevices = await window.api.getDevices({ token: authToken });
      devices = updatedDevices;
      updateDeviceListUI();
      populateDeviceDropdown(); // [수정] UI 업데이트 후 드롭다운도 갱신

      await switchDevice(deviceName); // 새로 추가된 기기를 이름으로 선택

      closeAddDeviceModal();
      document.getElementById("addDeviceForm").reset();
      alert(`'${deviceName}' 기기가 성공적으로 추가되었습니다.`);
    } catch (error) {
      console.error("기기 추가 오류:", error);
      alert(`기기 추가 실패: ${getCleanErrorMessage(error)}`);
    }
  });

// 기기 목록에서 특정 기기를 삭제합니다.
async function deleteDevice(index) {
  if (confirm(`'${devices[index].name}' 기기를 정말 삭제하시겠습니까?`)) {
    const deletedDeviceId = devices[index].name;
    const deviceIPToDelete = devices[index].ip; // API 호출에 사용할 IP

    try {
      await window.api.deleteDevice({
        token: authToken,
        ip: deviceIPToDelete,
      });

      // 서버에서 목록을 새로고침하여 전역 'devices' 변수와 UI를 업데이트합니다.
      // [수정] fetchDevicesFromAPI 대신 직접 목록을 다시 가져옵니다.
      const updatedDevices = await window.api.getDevices({ token: authToken });
      devices = updatedDevices;
      updateDeviceListUI();
      populateDeviceDropdown(); // [수정] UI 업데이트 후 드롭다운도 갱신

      // 삭제된 기기가 현재 선택된 기기라면 초기화
      if (deletedDeviceId === currentDeviceId) {
        await selectDevice(-1); // [수정] 기기 선택 해제 로직 호출
      }
      alert(`'${deletedDeviceId}' 기기가 성공적으로 삭제되었습니다.`);
    } catch (error) {
      console.error("기기 삭제 오류:", error);
      alert(`기기 삭제 실패: ${getCleanErrorMessage(error)}`);
    }
  }
}

// =====================================================
// 모달(Modal) 관련 함수
// =====================================================

// 과거 데이터 모달 열기
function openHistoryModal() {
  document.getElementById("historyModal").classList.add("active"); // 기본값 설정 (오늘 00:00 ~ 현재)

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  document.getElementById("historyStartTime").value =
    formatDateTimeLocal(today);
  document.getElementById("historyEndTime").value = formatDateTimeLocal(now);
}

// 과거 데이터 모달 닫기
function closeHistoryModal() {
  document.getElementById("historyModal").classList.remove("active");
  document.getElementById("historyResults").style.display = "none";
}

// 기기 추가 모달 열기
function openAddDeviceModal() {
  document.getElementById("addDeviceModal").classList.add("active");
}

// 기기 추가 모달 닫기
function closeAddDeviceModal() {
  document.getElementById("addDeviceModal").classList.remove("active");
}

// [추가] 불량률 임계값 설정 모달 열기
async function openThresholdSettingsModal() {
  if (!currentDeviceIP) {
    alert("먼저 설정을 변경할 기기를 선택해주세요.");
    return;
  }

  try {
    const levels = await window.api.getThresholds({
      token: authToken,
      device_ip: currentDeviceIP,
    });

    // 입력 필드에 현재 값 채우기
    document.getElementById("threshold_safe").value = levels.safe;
    document.getElementById("threshold_normal").value = levels.normal;
    document.getElementById("threshold_caution").value = levels.caution;
    document.getElementById("threshold_warning").value = levels.warning;
    document.getElementById("threshold_danger").value = levels.danger;

    document.getElementById("thresholdSettingsModal").classList.add("active");
  } catch (error) {
    console.error("임계값 설정 불러오기 오류:", error);
    alert(
      `임계값 설정을 불러오는 데 실패했습니다: ${getCleanErrorMessage(error)}`
    );
  }
}

// [추가] 불량률 임계값 설정 모달 닫기
function closeThresholdSettingsModal() {
  document.getElementById("thresholdSettingsModal").classList.remove("active");
}

// [추가] 임계값 설정 폼 제출 이벤트 리스너
document
  .getElementById("thresholdSettingsForm")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (!currentDeviceIP) {
      alert("기기가 선택되지 않았습니다.");
      return;
    }

    const newLevels = {
      safe: parseInt(document.getElementById("threshold_safe").value, 10),
      normal: parseInt(document.getElementById("threshold_normal").value, 10),
      caution: parseInt(document.getElementById("threshold_caution").value, 10),
      warning: parseInt(document.getElementById("threshold_warning").value, 10),
      danger: parseInt(document.getElementById("threshold_danger").value, 10),
    };

    // 간단한 유효성 검사 (값이 비어있지 않은지)
    for (const key in newLevels) {
      if (isNaN(newLevels[key])) {
        alert(`'${key}' 값이 유효하지 않습니다. 숫자를 입력해주세요.`);
        return;
      }
    }

    try {
      const result = await window.api.setLevels({
        token: authToken,
        device_ip: currentDeviceIP,
        levels: newLevels,
      });

      if (result.success) {
        alert("전송이 정상적으로 완료되었습니다.");
        closeThresholdSettingsModal();
        // [추가] 임계값 설정이 변경되었으므로, 전역 변수를 갱신합니다.
        fetchThresholds();
      } else {
        throw new Error(result.message || "알 수 없는 오류가 발생했습니다.");
      }
    } catch (error) {
      console.error("임계값 설정 전송 오류:", error);
      alert(`임계값 설정 실패: ${getCleanErrorMessage(error)}`);
    }
  });

// '과거 데이터 조회' 모달에서 '조회하기' 버튼 클릭 시 실행됩니다.
async function loadHistoryData() {
  const startTime = document.getElementById("historyStartTime").value;
  const endTime = document.getElementById("historyEndTime").value;

  if (!startTime || !endTime) {
    alert("시작 시간을 선택해주세요.");
    return;
  }
  try {
    const data = await window.api.getRangeData({
      token: authToken,
      start_time: startTime,
      end_time: endTime,
      device_ip: currentDeviceIP,
    });

    // [수정] 서버에서 판정한 'result' 값을 기준으로 good/defect 카운트
    const goodCount = data.data.filter((d) => d.result === "normal").length;
    const defectCount = data.data.filter((d) => d.result === "abnormal").length;

    const total = data.count;
    const defectRate = total > 0 ? ((defectCount / total) * 100).toFixed(2) : 0;

    document.getElementById("historyTotal").textContent = total;
    document.getElementById("historyGood").textContent = goodCount;
    document.getElementById("historyDefect").textContent = defectCount;
    document.getElementById("historyDefectRate").textContent = defectRate;
    document.getElementById("historyResults").style.display = "block";
  } catch (error) {
    console.error("과거 데이터 조회 오류:", error);
    alert(`데이터 조회 실패: ${getCleanErrorMessage(error)}`);
  }
}

// =====================================================
// 기타 유틸리티
// =====================================================

// datetime-local 형식으로 변환
function formatDateTimeLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

// '일일 로그 확인' 버튼 클릭 시 서버의 로그 폴더를 열도록 요청합니다.
async function openLogFolder() {
  try {
    const result = await window.api.openLogs({ token: authToken });
    if (result.success) {
      console.log("서버 로그 폴더 열기 요청 성공");
    } else {
      // 이 경우는 거의 발생하지 않음 (오류는 throw됨)
      alert("폴더 열기 실패");
    }
  } catch (error) {
    console.error("폴더 열기 오류:", error);
    alert(`폴더 열기 실패: ${getCleanErrorMessage(error)}`);
  }
}

// =====================================================
// 대시보드 초기화 및 메인 로직
// =====================================================

async function initDashboard() {
  // 주기적 업데이트 우선 중지
  if (updateInterval) clearInterval(updateInterval);

  // 마지막 기기 상태 불러오기 시도
  if (!loadCurrentDeviceState()) {
    currentDeviceId = null;
    currentDeviceIP = null;
    saveCurrentDeviceState();
  }

  updateDeviceListUI();
  populateDeviceDropdown();

  // 불러온 기기가 있으면 자동으로 선택
  if (currentDeviceId && currentDeviceIP) {
    const lastDeviceIndex = devices.findIndex((d) => d.ip === currentDeviceIP);
    if (lastDeviceIndex !== -1) {
      document.getElementById("deviceSelector").value = currentDeviceId; // 드롭다운 UI 업데이트
      await selectDevice(lastDeviceIndex); // This will set the new interval
    } else {
      // 목록에 없는 기기면 상태 초기화
      currentDeviceId = null;
      currentDeviceIP = null;
      saveCurrentDeviceState();
      await selectDevice(-1);
    }
  } else {
    await selectDevice(-1);
  }

  initChart();

  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  document.getElementById("exportStartTime").value = formatDateTimeLocal(today);
  restoreExpanderStates();
}

// 모달 외부 클릭시 닫기
window.addEventListener("click", (e) => {
  const historyModal = document.getElementById("historyModal");
  const deviceModal = document.getElementById("addDeviceModal");
  const videoModal = document.getElementById("videoModal"); // 영상 모달 추가

  if (e.target === historyModal) {
    closeHistoryModal();
  }
  if (e.target === deviceModal) {
    closeAddDeviceModal();
  }
  if (e.target === videoModal) {
    closeVideoModal();
  }
});

// =====================================================
// Expander (접고 펼치기 UI)
// =====================================================

/**
 * Expander 토글 함수
 * @param {string} contentId - 펼칠/접을 콘텐츠의 ID
 */
function toggleExpander(contentId) {
  const content = document.getElementById(contentId);
  const container = content.closest(".expander-container");

  if (!container) return; // container를 찾지 못하면 오류 방지

  if (container.classList.contains("collapsed")) {
    // 펼치기
    container.classList.remove("collapsed");
    saveExpanderState(contentId, true);
  } else {
    // 접기
    container.classList.add("collapsed");
    saveExpanderState(contentId, false);
  }
}

/**
 * Expander 상태 저장 (로컬 스토리지)
 * @param {string} contentId - 콘텐츠 ID
 * @param {boolean} isExpanded - 펼쳐진 상태 여부
 */
function saveExpanderState(contentId, isExpanded) {
  const expanderStates = JSON.parse(
    localStorage.getItem("expanderStates") || "{}"
  );
  expanderStates[contentId] = isExpanded;
  localStorage.setItem("expanderStates", JSON.stringify(expanderStates));
}

/**
 * Expander 상태 복원
 */
function restoreExpanderStates() {
  const expanderStates = JSON.parse(
    localStorage.getItem("expanderStates") || "{}"
  ); // 기본값: 모두 펼침

  const defaultStates = {
    controlsContent: true,
    dataTableContent: true,
    modelUpdateContent: true, // 모델 업데이트 expander 상태 추가
    deviceListContent: true, // 기기 목록 expander 상태 추가
  }; // 각 expander의 상태 복원

  Object.keys(defaultStates).forEach((contentId) => {
    const isExpanded = expanderStates.hasOwnProperty(contentId)
      ? expanderStates[contentId]
      : defaultStates[contentId];

    const content = document.getElementById(contentId);
    if (content) {
      const container = content.closest(".expander-container");
      if (container && !isExpanded) {
        container.classList.add("collapsed");
      }
    }
  });
}

/**
 * 모든 Expander 펼치기
 */
function expandAll() {
  document.querySelectorAll(".expander-container").forEach((container) => {
    container.classList.remove("collapsed");
  }); // 상태 저장

  const expanderStates = {};
  document.querySelectorAll(".expander-content").forEach((content) => {
    expanderStates[content.id] = true;
  });
  localStorage.setItem("expanderStates", JSON.stringify(expanderStates));
}

/**
 * 모든 Expander 접기
 */
function collapseAll() {
  document.querySelectorAll(".expander-container").forEach((container) => {
    container.classList.add("collapsed");
  }); // 상태 저장

  const expanderStates = {};
  document.querySelectorAll(".expander-content").forEach((content) => {
    expanderStates[content.id] = false;
  });
  localStorage.setItem("expanderStates", JSON.stringify(expanderStates));
}

// '확대 보기' 버튼 클릭 시 현장 영상 모달을 엽니다.
async function openVideoModal() {
  const modal = document.getElementById("videoModal");
  const largeVideoFeed = document.getElementById("largeVideoFeed");

  modal.style.display = "flex";
  modal.classList.add("active"); // 1. 먼저 플레이스홀더를 표시

  largeVideoFeed.src = "placeholder_video.png"; // 상대 경로로 수정

  if (!currentDeviceIP) {
    console.error("비디오 스트림 로드 실패: 선택된 기기 IP가 없습니다.");
    alert("큰 화면 영상을 보려면 먼저 기기를 선택해주세요.");
    return;
  }
  const timestamp = new Date().getTime();
  // [수정] Electron 프록시를 거치지 않고, 엣지 기기의 비디오 스트림 URL로 직접 요청합니다.
  largeVideoFeed.src = `http://${currentDeviceIP}/api/v1/video-feed?_t=${timestamp}`;

  largeVideoFeed.onerror = () => {
    console.error("큰 화면 비디오 스트림 오류:", largeVideoFeed.src);
    largeVideoFeed.src = "placeholder_video.png"; // 상대 경로로 수정
  };
}

// 현장 영상 모달을 닫습니다.
function closeVideoModal() {
  const modal = document.getElementById("videoModal");
  const largeVideoFeed = document.getElementById("largeVideoFeed"); // 1. 스트림 로드를 중지하여 자원 해제

  largeVideoFeed.src = ""; // 2. 모달 숨기기

  modal.classList.remove("active"); // active 클래스 제거 -> opacity: 1에서 0으로 전환 // CSS 트랜지션(0.3초)이 끝날 때까지 기다린 후 완전히 숨김

  setTimeout(() => {
    modal.style.display = "none";
  }, 300);
}

// =====================================================
// AI 모델 업데이트 (드래그 앤 드롭)
// =====================================================
const dropZone = document.getElementById("dropZone");
const modelFileInput = document.getElementById("modelFileInput");
const fileListContainer = document.getElementById("fileListContainer");
const fileList = document.getElementById("fileList");
const uploadModelButton = document.getElementById("uploadModelButton");
const uploadStatus = document.getElementById("uploadStatus");

if (dropZone) {
  // 드롭존 클릭 시 파일 입력창 열기
  dropZone.addEventListener("click", () => modelFileInput.click());

  // 드래그 이벤트
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragover");
  });

  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    const files = e.dataTransfer.files;
    if (files.length) {
      modelFileInput.files = files;
      handleFiles(files);
    }
  });

  // 파일 선택 이벤트
  modelFileInput.addEventListener("change", () => {
    handleFiles(modelFileInput.files);
  });

  // 모델 업로드 버튼 클릭 이벤트 추가
  uploadModelButton?.addEventListener("click", uploadModel);
}

// [추가] 선택된 모델 파일을 지우고 UI를 초기화하는 함수
function clearSelectedModelFile() {
  modelFileInput.value = ""; // 파일 입력 요소의 값 초기화
  fileList.innerHTML = ""; // 표시된 파일 이름 지우기
  fileListContainer.style.display = "none"; // 컨테이너 숨기기
  uploadModelButton.disabled = true; // 업로드 버튼 비활성화
  uploadStatus.textContent = ""; // 상태 메시지 지우기
}

function handleFiles(files) {
  // 이전 상태 초기화 (clearSelectedModelFile() 대신 직접 필요한 부분만 초기화)
  fileList.innerHTML = ""; 
  uploadStatus.textContent = "";

  if (files.length > 0) {
    const file = files[0];
    const allowedExtensions = [".pt", ".onnx", ".weights", ".zip", ".pth"];
    const fileExtension = file.name
      .slice(file.name.lastIndexOf("."))
      .toLowerCase();

    if (!allowedExtensions.includes(fileExtension)) {
      alert(
        "허용되지 않는 파일 형식입니다. (.pt, .onnx, .weights, .zip, .pth 파일만 허용됩니다.)"
      );
      // 잘못된 파일이므로 입력 필드를 다시 비웁니다.
      modelFileInput.value = "";
      fileListContainer.style.display = "none"; // 컨테이너 숨기기
      uploadModelButton.disabled = true; // 업로드 버튼 비활성화
      return;
    }

    // 파일 정보와 'X' 버튼을 li 요소에 추가
    const listItem = document.createElement("li");

    const textNode = document.createTextNode(
      `${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB) `
    );
    listItem.appendChild(textNode);

    const clearButton = document.createElement("button");
    clearButton.textContent = "X";
    clearButton.className = "btn-delete-file"; // 스타일링을 위한 클래스
    clearButton.type = "button";
    clearButton.onclick = (event) => {
      event.stopPropagation(); // 이벤트 버블링 방지
      clearSelectedModelFile();
    };

    listItem.appendChild(clearButton);
    fileList.appendChild(listItem);

    fileListContainer.style.display = "block";
    uploadModelButton.disabled = false;
  } else {
    // 파일이 선택되지 않은 경우, 모든 상태를 초기화합니다.
    clearSelectedModelFile();
  }
}

// '전송' 버튼 클릭 시 선택된 모델 파일을 백엔드로 업로드합니다.
async function uploadModel() {
  const files = modelFileInput.files;

  if (!currentDeviceIP) {
    alert("먼저 모델을 업데이트할 기기를 선택해주세요.");
    return;
  }

  if (files.length === 0) {
    alert("업로드할 파일을 선택해주세요.");
    return;
  }

  const file = files[0];
  const formData = new FormData();
  formData.append("model_file", file);

  const btn = uploadModelButton;
  const originalBtnText = btn.innerHTML;

  btn.disabled = true;
  uploadStatus.textContent = `[${currentDeviceId}] 기기에 모델 파일 전송 중...`;

  try {
    // Electron에서는 파일 객체 대신 파일 경로와 버퍼를 직접 전달해야 합니다.
    const fileBuffer = await file.arrayBuffer();
    const result = await window.api.updateModel({
      token: authToken,
      device_ip: currentDeviceIP,
      file: {
        buffer: fileBuffer,
        originalname: file.name,
        mimetype: file.type,
      },
    });

    if (result.success) {
      uploadStatus.textContent = `✅ 모델 업데이트 성공: ${result.message}`;
      alert(`모델 업데이트 성공: ${result.message}`);
    } else {
      throw new Error(result.detail || "알 수 없는 오류");
    }
  } catch (error) {
    console.error("모델 업데이트 오류:", error);
    uploadStatus.textContent = `❌ ${getCleanErrorMessage(error)}`;
    alert(getCleanErrorMessage(error));
  } finally {
    btn.disabled = false;
    // 업로드 후 파일 선택 상태 초기화
    clearSelectedModelFile();
  }
}



// '재부팅' 버튼 클릭 시 확인 모달을 엽니다.
function openRebootModal() {
  // 기기가 선택되지 않았으면 경고
  if (!currentDeviceIP || !currentDeviceId) {
    alert("명령을 보낼 기기를 먼저 선택해주세요.");
    return;
  }

  // 모달 내부에 기기 이름 표시
  document.getElementById("rebootTargetDevice").textContent = currentDeviceId;

  // 모달 표시
  document.getElementById("rebootModal").classList.add("active");
}

// 재부팅 확인 모달을 닫습니다.
function closeRebootModal() {
  document.getElementById("rebootModal").classList.remove("active");
}

// [추가] 데이터 삭제 확인 모달 열기
function openDeleteDataModal() {
  document.getElementById("deleteDataModal").classList.add("active");
}

// [추가] 데이터 삭제 확인 모달 닫기
function closeDeleteDataModal() {
  document.getElementById("deleteDataModal").classList.remove("active");
}

// [추가] 실제 데이터 삭제를 서버에 요청
async function executeDeleteData() {
  closeDeleteDataModal();

  try {
    const result = await window.api.deleteAllImages({ token: authToken });
    if (result.success) {
      alert(
        `${result.deleted_count}개의 저장된 이미지를 성공적으로 삭제했습니다.`
      );
    } else {
      throw new Error(result.message || "알 수 없는 오류가 발생했습니다.");
    }
  } catch (error) {
    console.error("데이터 삭제 오류:", error);
    alert(`데이터 삭제 실패: ${getCleanErrorMessage(error)}`);
  }
}

// 실제 재부팅 명령을 서버를 통해 엣지 기기로 전송합니다. (모달에서 '예' 클릭 시 호출)
async function executeReboot() {
  closeRebootModal();

  try {
    const result = await window.api.rebootDevice({
      token: authToken,
      device_ip: currentDeviceIP,
    });

    if (result.success) {
      // alert 대신 상태 메시지 표시
      showSyncStatus(result.message, "success");
    } else {
      // 이 경우는 거의 발생하지 않음 (오류는 throw됨)
      showSyncStatus("재부팅 명령 전송 실패", "error");
    }
  } catch (error) {
    console.error("재부팅 명령 오류:", error);
    showSyncStatus(getCleanErrorMessage(error), "error");
  }
}

// 모달 외부 클릭 시 닫기 이벤트에 재부팅 모달 추가
window.addEventListener("click", (e) => {
  const historyModal = document.getElementById("historyModal");
  const deviceModal = document.getElementById("addDeviceModal");
  const videoModal = document.getElementById("videoModal");
  const rebootModal = document.getElementById("rebootModal"); // 추가
  const deleteDataModal = document.getElementById("deleteDataModal"); // 추가

  if (e.target === historyModal) {
    closeHistoryModal();
  }
  if (e.target === deviceModal) {
    closeAddDeviceModal();
  }
  if (e.target === videoModal) {
    closeVideoModal();
  }
  if (e.target === rebootModal) {
    // 추가
    closeRebootModal();
  }
  if (e.target === deleteDataModal) {
    closeDeleteDataModal();
  }
});

// 서버로부터 현재 기기의 설정(임계값 등)을 가져와 UI에 반영합니다.
async function fetchDeviceConfig() {
  if (!currentDeviceIP) return;

  try {
    const config = await window.api.syncConfig({
      token: authToken,
      device_ip: currentDeviceIP,
    });
    if (config) {
      // 설정값 UI 반영 (예: 임계값)
      if (config.threshold && document.getElementById("thresholdInput")) {
        document.getElementById("thresholdInput").value = config.threshold;
      }

      // 성공 메시지 표시
      showSyncStatus("설정 동기화 완료", "success");
    } else {
      // 실패 메시지 표시
      showSyncStatus("설정 동기화에 실패했습니다.", "error");
    }
  } catch (error) {
    console.error("설정 동기화 오류:", error);
    showSyncStatus(getCleanErrorMessage(error), "error");
  }
}

// 재부팅, 동기화 등의 명령 후 결과를 헤더에 잠시 표시하는 함수
function showSyncStatus(message, type) {
  const statusEl = document.getElementById("syncStatusMessage");
  if (!statusEl) return;

  statusEl.textContent = message;

  if (type === "success") {
    statusEl.style.color = "#00ff88"; // 성공 시 네온 그린
  } else {
    statusEl.style.color = "#ff4d4d"; // 실패 시 빨강
  }

  // 메시지 표시
  statusEl.style.opacity = "1";

  // 3초 후 자동으로 숨김
  setTimeout(() => {
    statusEl.style.opacity = "0";
  }, 3000);
}
