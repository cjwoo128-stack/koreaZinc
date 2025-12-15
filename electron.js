// c:\Users\Jun\koreaZinc-node\electron.js

const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const path = require("path");
const fsPromises = require("fs").promises; // 비동기 파일 처리를 위해 fs.promises 사용
const nodeFetch = require("node-fetch");
const archiver = require("archiver");
const FormData = require("form-data");
const { exec } = require("child_process"); // 'open'이나 'start' 같은 OS 명령어를 실행하기 위함
const { format } = require("date-fns");
const fs = require("fs");
const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");

// ISO 8601 문자열(마이크로초 포함)을 안정적으로 파싱하는 헬퍼
const safeParseDate = (dateString) => {
  if (!dateString) return new Date();
  const [main, fractional] = dateString.split('.');
  if (fractional) {
    // 마이크로초(6자리)를 밀리초(3자리)로 잘라내고, UTC 시간(Z)으로 처리
    return new Date(`${main}.${fractional.substring(0, 3)}Z`);
  }
  // 'Z'가 없으면 UTC로 해석하도록 추가
  return new Date(dateString.endsWith('Z') ? dateString : dateString + 'Z');
};

// =====================================================
// 설정 (Python의 설정 부분과 동일)
// =====================================================
const SECRET_KEY = "your-secret-key-change-this-in-production";
const ACCESS_TOKEN_EXPIRE_MINUTES = 30;
const DATA_REQUEST_INTERVAL_SEC = 5; // [수정] 엣지 기기로 데이터 요청을 보내는 주기 (초)

// =====================================================
// 경로 설정 (Electron 환경에 맞게 수정)
// =====================================================
// app.isPackaged는 앱이 패키징되었는지 여부를 확인합니다.
// 패키징된 경우: storage 폴더는 asarUnpack으로 app.asar.unpacked에 추출됨
const baseDir = app.isPackaged
  ? path.join(process.resourcesPath, "app.asar.unpacked") // ASAR 압축 해제된 경로
  : __dirname;

// 디버깅용 로그 (패키징 문제 해결 후 제거 가능)
console.log("[PATH DEBUG] app.isPackaged:", app.isPackaged);
console.log("[PATH DEBUG] process.resourcesPath:", process.resourcesPath);
console.log("[PATH DEBUG] baseDir:", baseDir);

const UPLOAD_DIR = path.join(baseDir, "storage", "images");
const CSV_DIR = path.join(baseDir, "storage", "today_csv");
const DEVICES_FILE_PATH = path.join(baseDir, "storage", "devices.json");

console.log("[PATH DEBUG] UPLOAD_DIR:", UPLOAD_DIR);
console.log("[PATH DEBUG] CSV_DIR:", CSV_DIR);
console.log("[PATH DEBUG] DEVICES_FILE_PATH:", DEVICES_FILE_PATH);

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(CSV_DIR)) {
  fs.mkdirSync(CSV_DIR, { recursive: true });
}
if (!fs.existsSync(path.dirname(DEVICES_FILE_PATH))) {
  fs.mkdirSync(path.dirname(DEVICES_FILE_PATH), { recursive: true });
}

// =====================================================
// 데이터베이스 및 인메모리 데이터 (Python의 전역 변수와 동일)
// =====================================================
const fake_users_db = {
  koreazinc: {
    username: "koreazinc",
    // bcryptjs를 사용하여 'koreazinc!@34'을 해싱한 값
    hashed_password: bcrypt.hashSync("koreazinc!@34", 10),
    role: "admin",
  },
};

let devices = []; // 시작 시 파일에서 로드

// [수정] 기기 목록을 파일에서 로드하는 함수
function loadDevicesFromFile() {
  console.log(
    "[DEVICE LOAD] Attempting to load devices from:",
    DEVICES_FILE_PATH
  );
  try {
    const fileExists = fs.existsSync(DEVICES_FILE_PATH);
    console.log("[DEVICE LOAD] File exists:", fileExists);

    if (fileExists) {
      const data = fs.readFileSync(DEVICES_FILE_PATH, "utf8");
      devices = JSON.parse(data);
      console.log(
        "[DEVICE LOAD] Successfully loaded",
        devices.length,
        "devices:",
        JSON.stringify(devices)
      );
    } else {
      // 파일이 없으면 기본값으로 생성
      console.log("[DEVICE LOAD] File not found, creating empty devices.json");
      devices = [];
      saveDevicesToFile();
    }
  } catch (error) {
    console.error("[DEVICE LOAD] Failed to load device list file:", error);
    console.error("[DEVICE LOAD] Error stack:", error.stack);
    devices = [];
  }
}

// [수정] 기기 목록을 파일에 저장하는 함수
function saveDevicesToFile() {
  try {
    fs.writeFileSync(DEVICES_FILE_PATH, JSON.stringify(devices, null, 2));
    console.log("Device list saved to file.");
  } catch (error) {
    console.error("Failed to save device list file:", error);
  }
}

let current_stats = {
  total_inspections: 0,
  good_count: 0,
  defect_count: 0,
  operation_rate: 0.0,
  current_defect_rate: 0.0,
};

const device_settings = {
  // Python의 device_settings와 동일
  default_config: {
    levels: {
      safe: 0,
      normal: 20,
      caution: 40,
      warning: 60,
      danger: 80,
    },
    reporting_cycle_sec: 30.0,
  },
};

let inspection_data = []; // 수집된 모든 검사 데이터를 저장하는 인메모리 리스트
let total_request_count = 0; // 요청 시도 횟수
let last_reset_date = new Date(); // 마지막 초기화 날짜 (오늘 날짜로 초기화)
let device_status = {}; // 기기별 상태를 저장할 객체 (Python의 device_status와 동일)
let active_intervals = {}; // 활성 인터벌 ID를 저장하는 객체

// 기기 IP로 이름을 찾는 헬퍼 함수
const getDeviceNameByIp = (ip) => {
  const device = devices.find((d) => d.ip === ip);
  return device ? device.name : null;
};

const getDeviceConfig = (ip) => {
  // Python의 get_device_config와 동일
  return device_settings[ip] || device_settings["default_config"];
};

// =====================================================
// 백그라운드 작업 (호출되기 전에 먼저 정의)
// =====================================================
const periodic_data_request = (target_ip, interval) => {
  const task = async () => {
    total_request_count += 1;
    const device_id = getDeviceNameByIp(target_ip);
    if (!device_id) {
      console.log(
        `[Scheduler] Warning: device_id for ${target_ip} not found. Skipping.`
      );
      return;
    }

    const EDGE_REQUEST_URL = `http://${target_ip}/api/v1/data/request`;
    const payload = { device_id: device_id };

    try {
      console.log(
        `\n[Scheduler] Sending ${interval}s periodic request: ${EDGE_REQUEST_URL}, Payload: ${JSON.stringify(
          payload
        )}`
      );
      const response = await nodeFetch(EDGE_REQUEST_URL, {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        timeout: 5000,
      });
      if (!response.ok) throw new Error(`Orin Nano 오류 ${response.status}`);
      console.log(
        `[Scheduler] Request successful. Orin Nano response: ${response.status}`
      );
    } catch (error) {
      console.error(`[Scheduler] Data request failed: ${error.message}`);
    }
  };

  // 초기 실행
  task();
  // 이후 인터벌 설정
  return setInterval(task, interval * 1000);
};

const multer = require("multer");
const upload = multer({
  storage: multer.memoryStorage(), // 파일을 메모리에 임시 저장 (fs.writeFile로 직접 저장하기 위함)
});

const csv = require("fast-csv"); // CSV 파일 처리를 위한 라이브러리
// =====================================================
// 일렉트론 창 생성 및 생명주기
// =====================================================
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"), // preload 스크립트 지정
      contextIsolation: true,
    },
  });

  // 웹서버의 res.sendFile 대신, 창에 직접 파일을 로드합니다.
  mainWindow.loadFile(path.join(__dirname, "static", "index.html"));
}

// =====================================================
// 일렉트론 앱 생명주기
// =====================================================

app.whenReady().then(() => {
  createWindow();
  loadDevicesFromFile(); // [수정] 앱 시작 시 기기 목록 로드

  // [수정] Renderer(app.js)가 준비되었다는 신호를 받으면,
  // Main 프로세스가 준비되었다는 신호를 다시 보내줍니다.
  ipcMain.once("renderer-ready", (event) => {
    // [수정] 이제 데이터를 직접 실어서 보냅니다.
    mainWindow.webContents.send("main-ready", {
      devices: devices,
      stats: current_stats,
    });
  });

  // 서버 시작 시 실행되던 백그라운드 작업을 여기서 시작합니다.
  console.log(
    "Periodic data request scheduling moved to renderer process notification."
  );

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// =====================================================
// API 구현 (IPC - Inter-Process Communication)
// Express의 app.get, app.post 등을 ipcMain.handle로 대체합니다.
// =====================================================

// --- 모든 API 핸들러가 등록된 후 ---

// =====================================================
// API 구현 (IPC - Inter-Process Communication)
// Express의 app.get, app.post 등을 ipcMain.handle로 대체합니다.
// =====================================================

const verifyToken = (token) => {
  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    return { valid: true, user: decoded.sub };
  } catch (err) {
    return { valid: false, error: "Invalid token" };
  }
};

// --- 로그인 API ---
ipcMain.handle("api:login", (event, { username, password }) => {
  const user = fake_users_db[username];
  if (!user) {
    throw new Error("Incorrect username or password");
  }

  const isPasswordValid = bcrypt.compareSync(password, user.hashed_password);
  if (!isPasswordValid) {
    throw new Error("Incorrect username or password");
  }

  const accessToken = jwt.sign({ sub: username }, SECRET_KEY, {
    expiresIn: `${ACCESS_TOKEN_EXPIRE_MINUTES}m`,
  });

  return {
    access_token: accessToken,
    token_type: "bearer",
    username: username,
  };
});

// --- 데이터 요청 제어 API ---
ipcMain.handle(
  "api:start-periodic-data-request",
  (event, { token, device_ip }) => {
    if (!verifyToken(token).valid) throw new Error("Not authenticated");
    if (!device_ip) throw new Error("device_ip가 필요합니다.");

    // 이미 해당 IP에 대한 인터벌이 실행 중이면 중복 실행 방지
    if (active_intervals[device_ip]) {
      console.log(
        `[Scheduler] Data request for ${device_ip} is already running.`
      );
      return { success: true, message: "Already running." };
    }

    const deviceName = getDeviceNameByIp(device_ip);
    if (deviceName) {
      console.log(
        ` - [Task Started]: Target device '${deviceName}' (${device_ip}), Interval: ${DATA_REQUEST_INTERVAL_SEC}s`
      );
      const intervalId = periodic_data_request(
        device_ip,
        DATA_REQUEST_INTERVAL_SEC
      );
      active_intervals[device_ip] = intervalId;
      return { success: true, message: "Started." };
    } else {
      throw new Error(`Device with IP ${device_ip} not found.`);
    }
  }
);

ipcMain.handle(
  "api:stop-periodic-data-request",
  (event, { token, device_ip }) => {
    if (!verifyToken(token).valid) throw new Error("Not authenticated");
    if (!device_ip) {
      // IP가 지정되지 않으면 모든 인터벌 중지 (예: 로그아웃 시)
      console.log("[Scheduler] Stopping all periodic data requests.");
      for (const ip in active_intervals) {
        clearInterval(active_intervals[ip]);
        delete active_intervals[ip];
      }
      return { success: true, message: "All stopped." };
    }

    if (active_intervals[device_ip]) {
      console.log(`[Scheduler] Stopping data request for ${device_ip}.`);
      clearInterval(active_intervals[device_ip]);
      delete active_intervals[device_ip];
      return { success: true, message: "Stopped." };
    } else {
      return { success: false, message: "Not running." };
    }
  }
);

// --- 통계 API ---
ipcMain.handle("api:get-stats", (event, { token, device_ip }) => {
  if (!verifyToken(token).valid) throw new Error("Not authenticated");

  const config = device_ip
    ? getDeviceConfig(device_ip)
    : device_settings.default_config;

  // [수정] alert_threshold를 기기별 warning 레벨로 설정
  const currentAlertThreshold = config.levels
    ? config.levels.warning
    : device_settings.default_config.levels.warning;

  // For global stats (no device_ip)
  if (!device_ip) {
    return {
      ...current_stats,
      levels: config.levels,
      alert_threshold: currentAlertThreshold, // 전역 통계에도 반영
    };
  }

  const targetDeviceId = getDeviceNameByIp(device_ip);
  if (!targetDeviceId) {
    return {
      ...current_stats,
      alert_threshold: currentAlertThreshold, // 전역 통계에도 반영
      levels: config.levels,
    };
  }

  const device_data = inspection_data.filter(
    (d) => d.device_id === targetDeviceId
  );

  const total = device_data.length;
  const good = device_data.filter((d) => d.result === "normal").length;
  const defect = total - good;
  const defect_rate =
    total > 0 ? parseFloat(((defect / total) * 100).toFixed(2)) : 0.0;

  return {
    total_inspections: total,
    good_count: good,
    defect_count: defect,
    operation_rate: current_stats.operation_rate, // This is a global value
    levels: config.levels,
    current_defect_rate: defect_rate,
    alert_threshold: currentAlertThreshold, // 기기별 warning 레벨을 alert_threshold로 사용
  };
});

// --- 기기 관리 API ---
ipcMain.handle("api:get-devices", (event, { token }) => {
  if (!verifyToken(token).valid) throw new Error("Not authenticated");
  // [수정] 기기 목록을 반환할 때 각 기기의 levels 정보도 포함
  return devices.map((d) => ({
    ...d,
    levels:
      device_settings[d.ip]?.levels || device_settings.default_config.levels,
  }));
});

ipcMain.handle("api:add-device", (event, { token, name, ip }) => {
  if (!verifyToken(token).valid) throw new Error("Not authenticated");

  if (!name || !ip) {
    throw new Error("이름(name)과 IP 주소(ip)가 필요합니다.");
  }

  if (devices.some((d) => d.ip === ip)) {
    throw new Error(`IP 주소 ${ip}는 이미 등록되어 있습니다.`);
  }

  // [추가] 새 기기 추가 시 기본 임계값 설정도 함께 저장
  device_settings[ip] = { ...device_settings.default_config };
  const newDevice = { name, ip };
  devices.push(newDevice);
  saveDevicesToFile(); // [수정] 변경사항을 파일에 저장
  // res는 ipcMain 핸들러에 없으므로 반환 객체로 대체
  return { message: "Device added successfully", device: newDevice };
});

ipcMain.handle("api:delete-device", (event, { token, ip }) => {
  if (!verifyToken(token).valid) throw new Error("Not authenticated");
  const initialLength = devices.length;
  devices = devices.filter((d) => d.ip !== ip);

  if (devices.length === initialLength) {
    throw new Error(`IP 주소 ${ip}를 가진 기기를 찾을 수 없습니다.`);
  }
  saveDevicesToFile(); // [수정] 변경사항을 파일에 저장
  return { success: true };
});

// [활성화 및 수정] 단일 임계값 설정 핸들러 (warning 레벨만 업데이트)
ipcMain.handle(
  "api:set-threshold",
  (event, { token, threshold, device_ip }) => {
    if (!verifyToken(token).valid) throw new Error("Not authenticated");

    if (!device_ip) throw new Error("device_ip가 필요합니다.");

    if (!device_settings[device_ip]) {
      device_settings[device_ip] = { ...device_settings["default_config"] };
    }
    // [수정] 단일 임계값은 levels.warning에만 영향을 주도록 합니다.
    device_settings[device_ip].levels.warning = parseFloat(threshold);
    // [추가] 변경된 임계값을 파일에 저장
    const deviceIndex = devices.findIndex((d) => d.ip === device_ip);
    if (deviceIndex > -1)
      devices[deviceIndex].levels = device_settings[device_ip].levels;
    saveDevicesToFile();
    return { success: true, threshold: threshold, device_ip: device_ip };
  }
);

// [추가] 5단계 임계값(levels)을 설정하고 엣지 기기로 전송하는 새로운 핸들러
ipcMain.handle(
  "api:set-levels",
  async (event, { token, device_ip, levels }) => {
    if (!verifyToken(token).valid) throw new Error("Not authenticated");
    if (!device_ip) throw new Error("device_ip가 필요합니다.");
    if (!levels) throw new Error("levels 객체가 필요합니다.");

    // 1. 로컬 설정 업데이트
    if (!device_settings[device_ip]) {
      device_settings[device_ip] = { ...device_settings["default_config"] };
    }
    device_settings[device_ip].levels = levels;
    console.log(
      `[Config] Device '${device_ip}' levels updated in memory:`,
      levels
    );

    // [추가] 파일에 변경사항을 영구 저장
    const deviceIndex = devices.findIndex((d) => d.ip === device_ip);
    if (deviceIndex > -1) {
      devices[deviceIndex].levels = levels;
      saveDevicesToFile();
      console.log(
        `[Config] Device '${device_ip}' levels saved to devices.json.`
      );
    }

    // 2. 엣지 기기로 설정 전송
    const device_id = getDeviceNameByIp(device_ip);
    if (!device_id) {
      // device_ip에 해당하는 기기 이름(ID)을 찾지 못한 경우 오류 처리
      throw new Error(
        `IP 주소 ${device_ip}에 해당하는 기기를 찾을 수 없습니다.`
      );
    }

    const EDGE_THRESHOLD_URL = `http://${device_ip}/api/v1/threshold`;
    // [수정] 페이로드 형식을 명확히 하고, 각 level 값이 정수(integer)임을 보장합니다.
    const payload = {
      device_id: device_id,
      level: Object.fromEntries(
        Object.entries(levels).map(([key, value]) => [
          key,
          parseInt(value, 10) || 0,
        ])
      ),
    };

    console.log(
      `➡️ 엣지 기기로 임계값 설정 전송: ${EDGE_THRESHOLD_URL}`,
      JSON.stringify(payload)
    );
    const response = await nodeFetch(EDGE_THRESHOLD_URL, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`엣지 기기 오류(${response.status}): ${errorText}`);
    }

    return {
      success: true,
      message: `임계값 설정이 ${device_ip} 기기로 성공적으로 전송되었습니다.`,
    };
  }
);

// --- 데이터 수집 API ---
// 이 API는 엣지 기기에서 HTTP POST로 호출하므로 Express 서버가 필요합니다.
// Electron 앱 내부에 작은 Express 서버를 함께 실행합니다.
const expressApp = express();
expressApp.use(cors());
expressApp.post(
  "/api/v1/data/collect",
  upload.single("inspection_image"),
  async (req, res) => {
    // [추가] 요청받은 원본 데이터를 그대로 로그에 출력합니다.
    console.log(`[RAW DATA] Body: ${JSON.stringify(req.body)}`);

    const {
      datetime: datetime_str,
      device_id,
      confidence,
      class: class_result_str,
    } = req.body;

    const inspection_image = req.file; // Multer가 처리한 파일 정보
    const today = new Date();
    // 날짜가 변경되었는지 확인하고 통계 초기화 (Python의 last_reset_date 로직과 동일)
    if (today.toDateString() !== last_reset_date.toDateString()) {
      console.log(
        `📅 날짜 변경 감지: ${last_reset_date.toDateString()} -> ${today.toDateString()}. 통계 및 카운터를 초기화합니다.`
      );
      current_stats.total_inspections = 0;
      current_stats.good_count = 0;
      current_stats.defect_count = 0;
      current_stats.operation_rate = 0.0;
      total_request_count = 0;
      last_reset_date = today;
    }

    // [수정] filename 및 file_path를 먼저 정의하여 항상 사용 가능하게 합니다.
    // inspection_image가 없을 경우를 대비하여 filename과 file_path를 안전하게 초기화합니다.
    let filename = ""; // filename을 먼저 null 대신 빈 문자열로 초기화
    let file_path = "";

    if (inspection_image && inspection_image.originalname) {
      const filename_base = format(new Date(), "yyyyMMdd_HHmmss_SSS");
      const file_extension = path.extname(inspection_image.originalname);
      filename = `${device_id}_${filename_base}${file_extension}`;
      file_path = path.join(UPLOAD_DIR, filename);
    } else {
      console.log("No image file uploaded or originalname missing.");
      // filename과 file_path는 위에서 ""로 초기화된 상태를 유지
    }

    try {
      // 1. 이미지 저장 (로컬 디스크)
      if (inspection_image && inspection_image.buffer && filename) { // 이미지가 있고 filename이 있을 때만 저장 시도
        await fsPromises.writeFile(file_path, inspection_image.buffer);
        console.log(
          `Image saved: ${file_path} (Size: ${(
            inspection_image.buffer.length / 1024
          ).toFixed(2)} KB)`
        );
      } else if (filename) { // filename은 있지만 inspection_image.buffer가 없는 경우
          console.log(`Filename "${filename}" generated, but no image buffer to save. Skipping image save.`);
          // file_path는 여전히 존재할 수 있으나 실제 파일이 없으므로 비웁니다.
          file_path = "";
      } else { // filename 자체가 없는 경우 (예: inspection_image.originalname이 없는 경우)
          console.log("No valid filename generated. Skipping image save.");
          // file_path는 비어있는 상태를 유지
      }
    } catch (e) {
      console.error(`File save failed: ${e}`);
      file_path = ""; // 이미지 저장 실패 시 file_path를 비움
      return res
        .status(500)
        .json({ detail: `Error saving image file: ${e.message}` });
    }

    try {
      // 2. CSV 로그 저장 (일일 단위)
      const csv_filename = format(today, "yyyyMMdd") + ".csv";
      const csv_full_path = path.join(CSV_DIR, csv_filename);

      // [수정] class_result_str 값에 따라 'normal' 또는 'abnormal'로 변환합니다.
      const result_status = class_result_str === "0" ? "normal" : "abnormal";

      const file_exists = fs.existsSync(csv_full_path);

      const csv_data_row = {
        timestamp: datetime_str,
        device_id: device_id,
        result: result_status,
        confidence: parseFloat(confidence),
        image_filename: filename,
      };

      // CSV 파일에 데이터를 추가하는 스트림 방식 (안정적)
      const writableStream = fs.createWriteStream(csv_full_path, {
        flags: "a",
      });
      writableStream.on("finish", () => {
        // console.log("CSV write complete");
      });

      // fast-csv의 writeToStream 메소드 사용
      csv.writeToStream(writableStream, [csv_data_row], {
        headers: !file_exists,
        includeEndRowDelimiter: true,
      });
    } catch (e) {
      console.error(`Failed to save CSV: ${e}`);
    }

    // 3. 메타데이터 저장 (인메모리)
    const result_class = class_result_str === "0" ? "normal" : "abnormal";
    const server_time = new Date().toISOString();

    const new_data_point = {
      timestamp: datetime_str,
      device_id: device_id,
      result: result_class,
      confidence: parseFloat(confidence),
      image_filename: filename,
      created_at: server_time,
    };
    inspection_data.push(new_data_point);

    // 4. 통계 업데이트 (Python 로직과 동일)
    current_stats.total_inspections += 1;
    // [수정] 'normal'일 때 good_count를, 'abnormal'일 때 defect_count를 증가시킵니다.
    if (result_class === "normal") {
      current_stats.good_count += 1;
    } else {
      current_stats.defect_count += 1;
    }

    if (current_stats.total_inspections > 0) {
      current_stats.current_defect_rate = parseFloat(
        (
          (current_stats.defect_count / current_stats.total_inspections) *
          100
        ).toFixed(2)
      );
    }

    if (total_request_count > 0) {
      const op_rate =
        (current_stats.total_inspections / total_request_count) * 100;
      current_stats.operation_rate = Math.min(
        parseFloat(op_rate.toFixed(1)),
        100.0
      );
    }

    console.log(
      `✅ DATA RECEIVED: Device=${device_id}, Result=${result_class.toUpperCase()}, Time=${datetime_str}`
    );
    res.status(201).json({
      success: true,
      message: "데이터 및 이미지가 성공적으로 수신 및 처리되었습니다.",
      device_id: device_id,
    });
  }
);

// --- 데이터 조회 API ---
ipcMain.handle(
  "api:get-recent-data",
  (event, { token, minutes, device_ip }) => {
    if (!verifyToken(token).valid) throw new Error("Not authenticated");

    const cutoffTime = new Date(Date.now() - minutes * 60 * 1000);
    // [수정] device_ip가 유효할 때만 targetDeviceId를 찾도록 변경
    const targetDeviceId = device_ip ? getDeviceNameByIp(device_ip) : undefined;

    const filtered_data = inspection_data.filter((d) => {
      const itemTime = safeParseDate(d.timestamp); // [수정] safeParseDate 사용
      // 1. 시간 필터링
      const isRecent = itemTime > cutoffTime;
      if (!isRecent) return false;
      // 2. 기기 필터링
      // [수정] targetDeviceId가 undefined이면 기기 필터링을 적용하지 않습니다.
      const isTargetDevice =
        targetDeviceId === undefined || d.device_id === targetDeviceId;
      return isRecent && isTargetDevice;
    }).map(d => ({ // [추가] timestamp를 ISO 8601 UTC 문자열로 변환
        ...d,
        timestamp: safeParseDate(d.timestamp).toISOString()
    }));

    return {
      data: filtered_data,
      count: filtered_data.length,
    };
  }
);

ipcMain.handle(
  "api:get-range-data",
  (event, { token, start_time, end_time, device_ip }) => {
    if (!verifyToken(token).valid) throw new Error("Not authenticated");

    if (!start_time || !end_time) {
      throw new Error("start_time과 end_time이 필요합니다.");
    }

    const start = new Date(start_time);
    const end = new Date(end_time);
    // [수정] device_ip가 유효할 때만 targetDeviceId를 찾도록 변경
    const targetDeviceId = device_ip ? getDeviceNameByIp(device_ip) : undefined;

    const filtered_data = inspection_data.filter((d) => {
      const timestamp = new Date(d.timestamp);

      // 1. 시간 범위 필터링
      const inRange = timestamp >= start && timestamp <= end;
      if (!inRange) return false;
      // 2. 기기 필터링
      // [수정] targetDeviceId가 undefined이면 기기 필터링을 적용하지 않습니다.
      const isTargetDevice =
        targetDeviceId === undefined || d.device_id === targetDeviceId;
      return isTargetDevice;
    });

    return {
      data: filtered_data,
      count: filtered_data.length,
    };
  }
);

ipcMain.handle(
  "api:get-chart-data",
  async (event, { token, minutes, device_ip }) => {
    if (!verifyToken(token).valid) throw new Error("Not authenticated");

    const snapshot_interval_minutes = minutes <= 60 ? 1 : 3;
    const cutoffTime = new Date(Date.now() - minutes * 60 * 1000);
    const targetDeviceId = device_ip ? getDeviceNameByIp(device_ip) : undefined;

    // 1. 필터링 및 원본 데이터 수집
    const filtered_raw_data = inspection_data
      .filter((d) => {
        const itemTime = safeParseDate(d.timestamp); // [수정] safeParseDate 사용
        const isRecent = itemTime > cutoffTime;
        const isTargetDevice =
          targetDeviceId === undefined || d.device_id === targetDeviceId;
        return isRecent && isTargetDevice;
      })
      .map((d) => ({
        timestamp: safeParseDate(d.timestamp), // [수정] safeParseDate 사용, Date 객체로 변환
        confidence: d.confidence,
      }));

    // 2. 시간순 정렬
    filtered_raw_data.sort((a, b) => a.timestamp - b.timestamp);

    // 3. 일정 간격으로 데이터 샘플링 (스냅샷)
    const chart_data = [];
    let next_capture_time = null;

    for (const item of filtered_raw_data) {
      if (!next_capture_time || item.timestamp >= next_capture_time) {
        let conf_percent = item.confidence;
        if (conf_percent <= 1.0) {
          conf_percent *= 100;
        }

        chart_data.push({
          time: item.timestamp.toISOString(),
          confidence: parseFloat(conf_percent.toFixed(1)),
        });

        next_capture_time = new Date(
          item.timestamp.getTime() + snapshot_interval_minutes * 60 * 1000
        );
      }
    }

    return { data: chart_data };
  }
);

ipcMain.handle("api:get-alerts", (event, { token }) => {
  if (!verifyToken(token).valid) throw new Error("Not authenticated");
  const alerts = [];
  if (inspection_data.length > 0) {
    const last_data = inspection_data[inspection_data.length - 1];
    // 디바이스에서 넘어온 class 값(result)을 기반으로 알림 발생
    if (last_data.result === "abnormal") {
      alerts.push({
        type: "danger",
        message: `경고: 장비에서 비정상으로 판정된 항목이 감지되었습니다! (Device: ${
          last_data.device_id
        }, Confidence: ${last_data.confidence.toFixed(1)}%)`,
        timestamp: new Date().toISOString(),
      });
    }
  }
  return { alerts: alerts };
});

// [수정] ZIP 압축 다운로드
ipcMain.handle(
  "api:export-zip",
  async (event, { token, start_time, end_time, device_ip }) => {
    if (!verifyToken(token).valid) throw new Error("Not authenticated");

    const start_dt = new Date(start_time);
    const end_dt = new Date(end_time);
    const targetDeviceId = device_ip ? getDeviceNameByIp(device_ip) : null;

    // 1. "다른 이름으로 저장" 대화상자 먼저 열기
    const defaultFilename = `${format(start_dt, "yyMMddHHmm")}_${
      targetDeviceId || "all"
    }.zip`;
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "ZIP 파일로 내보내기",
      defaultPath: defaultFilename,
      filters: [{ name: "ZIP 파일", extensions: ["zip"] }],
    });

    if (canceled || !filePath) {
      return { filePath: null }; // 사용자가 취소한 경우
    }

    // 2. 데이터 필터링 및 ZIP 생성
    try {
      const output = fs.createWriteStream(filePath);
      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.pipe(output);

      // 날짜 범위 내의 모든 CSV 파일을 순회
      for (
        let d = new Date(start_dt);
        d <= end_dt;
        d.setDate(d.getDate() + 1)
      ) {
        const dateStr = format(d, "yyyyMMdd");
        const csvPath = path.join(CSV_DIR, `${dateStr}.csv`);

        if (fs.existsSync(csvPath)) {
          const csvContent = await fsPromises.readFile(csvPath, "utf-8");
          const records = [];
          await new Promise((res, rej) => {
            csv
              .parseString(csvContent, { headers: true })
              .on("data", (data) => records.push(data))
              .on("end", () => res())
              .on("error", (error) => rej(error));
          });

          const filteredRecords = records.filter((record) => {
            const recordTime = new Date(record.timestamp);
            const timeMatch = recordTime >= start_dt && recordTime <= end_dt;
            const deviceMatch =
              !targetDeviceId || record.device_id === targetDeviceId;
            return timeMatch && deviceMatch;
          });

          if (filteredRecords.length > 0) {
            // 해당 이미지 파일들을 ZIP에 추가
            for (const record of filteredRecords) {
              const imagePath = path.join(UPLOAD_DIR, record.image_filename.replace(/"/g, ""));
              if (fs.existsSync(imagePath)) {
                archive.file(imagePath, {
                  name: `images/${path.basename(imagePath)}`,
                });
              }
            }
            // 필터링된 CSV 내용을 ZIP에 추가
            const filteredCsvString = await csv.writeToString(filteredRecords, {
              headers: true,
            });
            archive.append(filteredCsvString, {
              name: `${dateStr}_filtered.csv`,
            });
          }
        }
      }

      await archive.finalize();
      return { filePath };
    } catch (error) {
      console.error("ZIP 생성 중 오류 발생:", error);
      throw new Error("ZIP 파일 생성 중 오류가 발생했습니다.");
    }
  }
);

// 모델 업데이트 (프록시)
ipcMain.handle(
  "api:update-model",
  async (event, { token, device_ip, file }) => {
    if (!verifyToken(token).valid) throw new Error("Not authenticated");

    if (!file) throw new Error("모델 파일이 없습니다.");
    const EDGE_API_URL = `http://${device_ip}/api/v1/model/update`;
    console.log(`➡️ 엣지 기기로 모델 전송 시작: ${EDGE_API_URL}`);

    const form = new FormData();
    // [수정] 프론트에서 받은 ArrayBuffer를 Buffer로 변환하고, 올바른 변수(file)를 사용합니다.
    const fileBuffer = Buffer.from(file.buffer);

    form.append("file", fileBuffer, {
      filename: file.originalname,
      contentType: file.mimetype,
    });

    try {
      const edge_response = await nodeFetch(EDGE_API_URL, {
        method: "POST",
        body: form,
        headers: form.getHeaders(),
        timeout: 300000, // 5분 타임아웃
      });

      if (!edge_response.ok) {
        // [추가] 409 Conflict 오류를 별도로 처리하여 사용자에게 명확한 메시지를 전달합니다.
        if (edge_response.status === 409) {
          throw new Error(
            "모델 파일 이름이 중복되었습니다. 파일 이름을 변경하십시오."
          );
        }
        const errorText = await edge_response.text();
        throw new Error(
          `엣지 기기 오류(${edge_response.status}): ${errorText}`
        );
      }

      console.log(`🎉 엣지 기기 응답: ${edge_response.status}`);
      return {
        success: true,
        message: `'${file.originalname}' 모델이 ${device_ip} 기기로 성공적으로 전송되었습니다.`,
        device_ip: device_ip,
      };
    } catch (error) {
      console.error(`❌ 모델 전송 실패: ${error.message}`);
      // [수정] 409 오류의 경우, 접두사 없이 원본 메시지만 전달합니다.
      if (
        error.message ===
        "모델 파일 이름이 중복되었습니다. 파일 이름을 변경하십시오."
      ) {
        throw error; // 원본 오류를 그대로 다시 던집니다.
      }
      // 그 외 다른 오류들은 기존처럼 접두사를 붙여서 던집니다.
      throw new Error(
        `모델 전송 실패: ${device_ip} 기기와의 통신 중 오류가 발생했습니다. (${error.message})`
      );
    }
  }
);

// 비디오 스트림 프록시
// 이 API는 MJPEG 스트림을 직접 브라우저로 보내야 하므로 Express 서버가 필요합니다.
expressApp.get("/api/v1/video-feed", async (req, res) => {
  const { device_ip } = req.query;
  if (!device_ip) return res.status(400).send("Device IP is required");

  // [수정] 비디오 URL을 동적으로 생성합니다.
  const video_url = `http://${device_ip}/api/v1/video-feed`;

  try {
    const response = await nodeFetch(video_url, { timeout: 15000 });
    if (!response.ok)
      throw new Error(`Unexpected response ${response.statusText}`);
    res.setHeader("Content-Type", "multipart/x-mixed-replace; boundary=frame");
    response.body.pipe(res);
  } catch (error) {
    console.error(`!!! Video stream error: ${error}`);
    res.status(503).send("Video stream is unavailable");
  }
});

ipcMain.handle("api:reboot-device", async (event, { token, device_ip }) => {
  if (!verifyToken(token).valid) throw new Error("Not authenticated");
  const device_id = getDeviceNameByIp(device_ip);
  const EDGE_CONTROL_URL = `http://${device_ip}/api/v1/control/reboot`;
  console.log(`➡️ 원격 재부팅 명령 전송: ${EDGE_CONTROL_URL}`);

  try {
    const edge_response = await nodeFetch(EDGE_CONTROL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: device_id }),
      timeout: 10000,
    });

    if (!edge_response.ok) {
      throw new Error(`엣지 기기 오류: ${edge_response.status}`);
    }

    return {
      success: true,
      message: `${device_ip} 기기에 재부팅 명령을 성공적으로 전달했습니다.`,
    };
  } catch (error) {
    console.error(`❌ 재부팅 명령 실패: ${error.message}`);
    throw new Error(`재부팅 명령 실패: ${error.message}`);
  }
});

ipcMain.handle("api:sync-config", (event, { token, device_ip }) => {
  if (!verifyToken(token).valid) throw new Error("Not authenticated");
  if (!device_ip) throw new Error("device_ip가 필요합니다.");
  const config = getDeviceConfig(device_ip);
  return {
    threshold: config.threshold,
    reporting_cycle_sec: config.reporting_cycle_sec,
  };
});

// 엣지 기기 상태 보고
// Python의 @app.post("/api/v1/status/report")와 동일
expressApp.post("/api/v1/status/report", (req, res) => {
  const signal = req.body;
  const required_keys = [
    "device_id",
    "timestamp",
    "cpu_usage",
    "gpu_tmp",
    "memory_usage",
    "connection_status",
  ];
  if (!required_keys.every((key) => key in signal)) {
    return res.status(400).json({ detail: "필수 필드가 누락되었습니다." });
  }
  const device_id = signal.device_id;
  device_status[device_id] = {
    ...signal,
    last_report: new Date().toISOString(),
  };
  console.log(
    `Alive Signal 수신: Device=${device_id}, CPU=${signal.cpu_usage}%, Temp=${signal.gpu_tmp}°C`
  );
  res.json({
    success: true,
    device_id: device_id,
    last_report: device_status[device_id].last_report,
  });
});

ipcMain.handle("api:open-logs", (event, { token }) => {
  // [수정] { token } 파라미터 추가
  if (!verifyToken(token).valid) throw new Error("Not authenticated");

  // [수정] OS 명령어(exec) 대신 Electron의 내장 API인 shell.openPath를 사용합니다.
  const abs_path = path.resolve(CSV_DIR);
  console.log(`Attempting to open server folder: ${abs_path}`);

  // [수정] shell.openPath는 Promise를 반환하므로, 이를 사용하여 비동기적으로 처리합니다.
  return shell.openPath(abs_path).then((errorMessage) => {
    if (errorMessage) {
      throw new Error(`폴더 열기 실패: ${errorMessage}`);
    }
    return { success: true, message: "폴더 열기 명령을 실행했습니다." };
  });
});

// [추가] 저장된 모든 이미지 데이터 삭제
ipcMain.handle("api:delete-all-images", async (event, { token }) => {
  if (!verifyToken(token).valid) throw new Error("Not authenticated");

  try {
    const files = await fsPromises.readdir(UPLOAD_DIR);
    let deletedCount = 0;
    for (const file of files) {
      const filePath = path.join(UPLOAD_DIR, file);
      // 파일인지 확인하고 삭제
      const stat = await fsPromises.stat(filePath);
      if (stat.isFile()) {
        await fsPromises.unlink(filePath);
        deletedCount++;
      }
    }
    console.log(`[Data Deletion] Successfully deleted ${deletedCount} images.`);
    return { success: true, deleted_count: deletedCount };
  } catch (error) {
    console.error(`[Data Deletion] Failed to delete images:`, error);
    throw new Error("이미지 삭제 중 오류가 발생했습니다.");
  }
});

// =====================================================
// 데이터 수신을 위한 Express 서버 시작
// =====================================================
const PORT = 8008;
// [수정] '0.0.0.0'으로 바인딩하여 모든 네트워크 인터페이스에서 접근 가능하도록 변경
// 이렇게 해야 엣지 기기에서 이 PC의 IP로 /api/v1/data/collect에 POST 할 수 있음
expressApp.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[EXPRESS] Data receiving server is running at http://0.0.0.0:${PORT}`
  );
  console.log(
    `[EXPRESS] 엣지 기기에서 이 PC의 IP:${PORT}/api/v1/data/collect로 데이터를 전송해야 합니다.`
  );
});

ipcMain.handle("api:get-thresholds", (event, { token, device_ip }) => {
  if (!verifyToken(token).valid) throw new Error("Not authenticated");
  if (!device_ip) throw new Error("device_ip필요");

  if (device_settings[device_ip] && device_settings[device_ip].levels) {
    return device_settings[device_ip].levels;
  }

  const deviceInFile = devices.find((d) => d.ip === device_ip);
  if (deviceInFile && deviceInFile.levels) {
    return deviceInFile.levels;
  }

  return device_settings.default_config.levels;
});
