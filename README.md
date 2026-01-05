# 시각 지능 색차 식별 시스템 (Korea Zinc Color Vision System)

`koreazinc-node`는 Electron을 기반으로 구축된 데스크톱 애플리케이션으로, 시각 지능을 활용한 색차 식별 및 데이터 관리 기능을 제공합니다.

## 주요 기능

-   **색차 식별 및 분석**: 이미지 또는 센서 데이터를 기반으로 색상 차이를 정밀하게 분석합니다.
-   **데이터 관리**: 분석된 데이터는 로컬 `storage`에 저장 및 관리됩니다.
-   **사용자 인증**: `jsonwebtoken`을 활용하여 안전한 사용자 인증 및 세션 관리를 지원합니다.
-   **로컬 서버**: Express.js를 내장하여 데이터 처리 및 API 기능을 제공합니다.

## 개발 환경 설정

이 프로젝트를 로컬 환경에서 실행하기 위한 안내입니다.

### 사전 준비

-   [Node.js](https://nodejs.org/) (npm 포함)가 설치되어 있어야 합니다.

### 설치 및 실행

1.  **프로젝트 클론:**
    ```sh
    git clone <저장소_URL>
    cd koreazinc-node
    ```

2.  **의존성 설치:**
    프로젝트에 필요한 모든 라이브러리를 설치합니다.
    ```sh
    npm install
    ```

3.  **개발 모드에서 실행:**
    애플리케이션을 개발 모드로 시작합니다. 파일 변경 시 자동으로 리로드될 수 있습니다.
    ```sh
    npm start
    ```

## 프로덕션 빌드

배포 가능한 설치 파일(`.exe`)을 생성합니다.

1.  **빌드 명령어 실행:**
    ```sh
    npm run build
    ```

2.  **결과물 확인:**
    위 명령어를 실행하면 `electron-builder`가 작동하여 애플리케이션을 패키징합니다. 생성된 설치 파일은 프로젝트 루트의 **`dist`** 폴더에서 찾을 수 있습니다. (예: `dist/시각 지능 색차 식별 시스템 Setup 1.0.2.exe`)

## 기술 스택

-   **프레임워크**: [Electron](https://www.electronjs.org/)
-   **백엔드**: [Node.js](https://nodejs.org/), [Express.js](https://expressjs.com/)
-   **인증**: [JSON Web Token (jsonwebtoken)](https://github.com/auth0/node-jsonwebtoken)
-   **패키징**: [electron-builder](https://www.electron.build/)
