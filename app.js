let stationNameMap = {};       
let masterJsonData = null;     

let currentSortCol = 'ObsTime'; 
let currentSortAsc = false;     
let groupControllers = [];
let groupStateCache = {}; 

let pieChartInstance = null;
let barChartInstance = null;
let modalTrendChartInstance = null; 

let currentWorstB_Info = null;
let currentWorstC_Info = null;

let filterTimeout = null;

// 全域變數，用來存放熱力圖專用的過濾後數據
let currentHeatmapData = {}; 

let hourlyBarChartInstance = null;

function debounceApplyFilters() {
    if (filterTimeout) clearTimeout(filterTimeout);
    filterTimeout = setTimeout(() => { applyFilters(); }, 300); 
}

const btnTableView = document.getElementById('btnTableView');
const btnChartView = document.getElementById('btnChartView');
const tableArea = document.getElementById('tableArea');
const chartsArea = document.getElementById('chartsArea');

btnTableView.addEventListener('click', () => {
    btnTableView.classList.add('active');
    btnChartView.classList.remove('active');
    tableArea.style.display = 'block';
    chartsArea.style.display = 'none';
});

btnChartView.addEventListener('click', () => {
    btnChartView.classList.add('active');
    btnTableView.classList.remove('active');
    tableArea.style.display = 'none';
    chartsArea.style.display = 'flex'; 
});

async function loadStationNames() {
    try {
        const response = await fetch(`station.json?t=${new Date().getTime()}`, { cache: "no-store" });
        const data = await response.json();
        const stids = data.stids || {};
        stationNameMap = {};
        for (const [k6, info] of Object.entries(stids)) {
            const shortID = k6.substring(0, 5);
            // 🌟 讓大腦不僅記住長名稱，也同時記住 owner 單位
            stationNameMap[shortID] = {
                name: info.long_name || info.name || "未知新站",
                owner: info.owner || "未知單位",
                publish: info.publish !== undefined ? info.publish : 0 // 如果沒寫預設為 0
            };
        }
    } catch (e) {
        console.error("⚠️ 無法讀取對照檔:", e);
    }
}



async function fetchDashboardData() {
    const tbody = document.querySelector('#dataTable tbody');
    const fileText = document.getElementById('currentFileText');
    
    const selectedYear = document.getElementById('yearSelect').value;
    const selectedMonth = document.getElementById('monthSelect').value;
    const targetYYYYMM = `${selectedYear}${selectedMonth}`;
    const jsonUrl = `./qcresult/qc_results_${targetYYYYMM}.json`;
    
    fileText.textContent = `(目前讀取：qc_results_${targetYYYYMM}.json)`;
    tbody.innerHTML = '<tr><td colspan="10" style="text-align: center;">載入資料中...</td></tr>';
    
    document.getElementById('searchInput').value = '';
    document.getElementById('dateFilter').value = '';
    document.getElementById('levelFilter').value = 'ALL';
    document.getElementById('itemFilter').value = 'ALL';
    document.getElementById('methodFilter').value = '';
    groupStateCache = {}; 

    if (Object.keys(stationNameMap).length === 0) {
        await loadStationNames();
    }

    try {
        const response = await fetch(`${jsonUrl}?t=${new Date().getTime()}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`找不到 ${selectedYear} 年 ${selectedMonth} 月的資料，可能尚未產出。`);
        
        masterJsonData = await response.json();
        
        // 🌟 智慧對帳：抓出基礎 JSON 對照表裡面沒有的漏網之魚
        if (masterJsonData && masterJsonData.records) {
            const missingStations = new Set();
            
            masterJsonData.records.forEach(r => {
                // 如果異常紀錄裡的 ID，在我們的 stationNameMap 字典裡找不到，就是漏掉的站！
                if (r.ID && !stationNameMap[r.ID]) {
                    missingStations.add(r.ID);
                }
            });
            
            // 把結果漂亮地印在瀏覽器的 F12 Console 裡
            console.log("%c=== 🔍 基礎對照表不完整測站檢查 ===", "color: #ffc107; font-weight: bold; font-size: 14px;");
            if (missingStations.size > 0) {
                console.warn(`🚨 警告：發現有 ${missingStations.size} 個測站存在於異常紀錄中，但不在對照表 JSON 裡！`);
                console.log("📋 缺失的測站 ID 清單如下（請複製去補齊 JSON）：");
                console.log(Array.from(missingStations).sort());
            } else {
                console.log("✅ 恭喜！目前的基礎對照表非常完整，沒有遺漏任何測站！");
            }
            console.log("=====================================");
        }

        calculateStaticKPIs(); 
        applyFilters(); 

    } catch (error) {
        masterJsonData = null;
        tbody.innerHTML = `<tr><td colspan="10" class="error-msg" style="text-align: center;">讀取失敗：${error.message}</td></tr>`;
        if (pieChartInstance) pieChartInstance.destroy();
        if (barChartInstance) barChartInstance.destroy();
        
        document.getElementById('kpiTodayCount').textContent = '0';
        document.getElementById('kpiMonthCount').textContent = '0';
        document.getElementById('kpiWorstStationB').textContent = '無資料';
        document.getElementById('kpiWorstStationC').textContent = '無資料';
        currentWorstB_Info = null;
        currentWorstC_Info = null;
    }
}
// 1. 取得開關 DOM 元素
const publishToggle = document.getElementById('publishToggle');

// 2. 當開關狀態改變時，觸發你專案專屬的過濾函數
if (publishToggle) {
    publishToggle.addEventListener('change', applyFilters);
}


function calculateStaticKPIs() {
    if (!masterJsonData || !masterJsonData.records || masterJsonData.records.length === 0) {
        currentWorstB_Info = null;
        currentWorstC_Info = null;
        return;
    }

    const today = new Date();
    const offset = today.getTimezoneOffset() * 60000;
    const localDateStr = (new Date(today - offset)).toISOString().split('T')[0];
    const currentRealYear = localDateStr.substring(0, 4);
    const currentRealMonth = localDateStr.substring(5, 7);
    
    const selectedYear = document.getElementById('yearSelect').value;
    const selectedMonth = document.getElementById('monthSelect').value;
    
    const isCurrentMonth = (selectedYear === currentRealYear && selectedMonth === currentRealMonth);

    const monthRecords = masterJsonData.records;
    const uniqueMonthStations = new Set(monthRecords.map(r => r.ID)).size;
    const monthDenominator = masterJsonData.summary.total_active_stations || 0;
    const monthRate = monthDenominator > 0 ? ((uniqueMonthStations / monthDenominator) * 100).toFixed(1) : '0.0';

    let targetRecordsForFocus = [];

    if (isCurrentMonth) {
        const allDates = monthRecords.map(r => r.met_date).filter(d => d);
        const latestDate = allDates.sort().reverse()[0] || localDateStr; 
        const todayRecords = monthRecords.filter(r => r.met_date === latestDate);
        
        const uniqueTodayStations = new Set(todayRecords.map(r => r.ID)).size;
        const todaySnapshot = masterJsonData.daily_snapshots[latestDate];
        const todayDenominator = todaySnapshot ? todaySnapshot.total_stations_count : 0;
        const todayRate = todayDenominator > 0 ? ((uniqueTodayStations / todayDenominator) * 100).toFixed(1) : '0.0';

        document.getElementById('kpiTitle1').innerHTML = "🚨 本日累計異常測站數 <span class='card-hint'>👆 點擊看時序圖</span>";
        animateValue("kpiTodayCount", 0, uniqueTodayStations, 300);
        document.getElementById('kpiTodaySub').textContent = `${latestDate.substring(5).replace('-', '月')}日 (佔全網 ${todayRate}%)`;

        document.getElementById('kpiTitle2').innerHTML = "📅 本月累計異常 <span class='card-hint'>👆 點擊看熱力圖</span>";
        animateValue("kpiMonthCount", 0, uniqueMonthStations, 300);
        document.getElementById('kpiMonthSub').textContent = `全月活躍佔比 ${monthRate}%`;

        document.getElementById('kpiTitle3').innerHTML = "🏆 本日焦點關注 (B級) <span class='card-hint'>👆 點擊看履歷</span>";
        document.getElementById('kpiTitle4').innerHTML = "🔴 本日焦點關注 (C級) <span class='card-hint'>👆 點擊看履歷</span>";
        targetRecordsForFocus = todayRecords; 
    } else {
        // 🌟 這裡補上「24H 作息圖」的提示徽章！
        document.getElementById('kpiTitle1').innerHTML = "🚨 本月累計異常測站數 <span class='card-hint'>👆 點擊看 24H 作息圖</span>";
        animateValue("kpiTodayCount", 0, uniqueMonthStations, 300);
        document.getElementById('kpiTodaySub').textContent = `全月活躍佔比 ${monthRate}%`;

        document.getElementById('kpiTitle2').innerHTML = "📅 本月累計總異常 <span class='card-hint'>👆 點擊看熱力圖</span>";
        animateValue("kpiMonthCount", 0, monthRecords.length, 300); 
        document.getElementById('kpiMonthSub').textContent = `歷史整月資料筆數`;

        document.getElementById('kpiTitle3').innerHTML = "🏆 本月焦點關注 (B級) <span class='card-hint'>👆 點擊看履歷</span>";
        document.getElementById('kpiTitle4').innerHTML = "🔴 本月焦點關注 (C級) <span class='card-hint'>👆 點擊看履歷</span>";
        targetRecordsForFocus = monthRecords; 
    }

    let tallyB = {}; let tallyC = {};
    let itemsB = {}; let itemsC = {};
    let radioMap = {}; 
    
    targetRecordsForFocus.forEach(r => {
        const stInfo = stationNameMap[r.ID] || { name: r.ID };
        const stName = stInfo.name; 
        
        const fullKey = `${stName}(${r.ID})`;
        const item = r.ObsItem || '未知';
        const conf = (r.Confidence_Level || '').toUpperCase();
        
        radioMap[r.ID] = r.Radio_id || '未知模組';

        if (conf === 'B') {
            tallyB[fullKey] = (tallyB[fullKey] || 0) + 1;
            if(!itemsB[fullKey]) itemsB[fullKey] = {};
            itemsB[fullKey][item] = (itemsB[fullKey][item] || 0) + 1;
        } else if (conf === 'C') {
            tallyC[fullKey] = (tallyC[fullKey] || 0) + 1;
            if(!itemsC[fullKey]) itemsC[fullKey] = {};
            itemsC[fullKey][item] = (itemsC[fullKey][item] || 0) + 1;
        }
    });

    function getTopItemLabel(itemCountsObj) {
        if (!itemCountsObj) return '無';
        const sorted = Object.entries(itemCountsObj).sort((a, b) => b[1] - a[1]);
        return sorted.length > 0 ? sorted[0][0] : '無';
    }

    const sortedB = Object.entries(tallyB).sort((a, b) => b[1] - a[1]);
    const worstBStr = sortedB.length > 0 ? sortedB[0][0] : '全網健康';
    const worstBCount = sortedB.length > 0 ? sortedB[0][1] : 0;
    const worstBItem = sortedB.length > 0 ? getTopItemLabel(itemsB[worstBStr]) : '--';

    const sortedC = Object.entries(tallyC).sort((a, b) => b[1] - a[1]);
    const worstCStr = sortedC.length > 0 ? sortedC[0][0] : '全網健康';
    const worstCCount = sortedC.length > 0 ? sortedC[0][1] : 0;
    const worstCItem = sortedC.length > 0 ? getTopItemLabel(itemsC[worstCStr]) : '--';

    document.getElementById('kpiWorstStationB').textContent = worstBStr;
    document.getElementById('kpiWorstCountB').innerHTML = worstBCount > 0 ? `發生 ${worstBCount} 次 | <span style="background:#e9ecef; color:#0056b3; padding:2px 6px; border-radius:3px;">主項目: ${worstBItem}</span>` : '無異常';
    
    document.getElementById('kpiWorstStationC').textContent = worstCStr;
    document.getElementById('kpiWorstCountC').innerHTML = worstCCount > 0 ? `發生 ${worstCCount} 次 | <span style="background:#f8d7da; color:#dc3545; padding:2px 6px; border-radius:3px;">主項目: ${worstCItem}</span>` : '無異常';

    // 🌟 修正 Regex：支援名字裡自帶括號的測站 (由後往前抓 ID)
    currentWorstB_Info = null;
    if (sortedB.length > 0) {
        const matchB = worstBStr.match(/(.*)\(([^)]+)\)$/);
        if (matchB) currentWorstB_Info = { name: matchB[1], id: matchB[2], radio: radioMap[matchB[2]] };
    }

    currentWorstC_Info = null;
    if (sortedC.length > 0) {
        const matchC = worstCStr.match(/(.*)\(([^)]+)\)$/);
        if (matchC) currentWorstC_Info = { name: matchC[1], id: matchC[2], radio: radioMap[matchC[2]] };
    }
}

function clickKpiCard(level) {
    let data = level === 'B' ? currentWorstB_Info : currentWorstC_Info;
    if (data) {
        openStationModal(data.id, data.name, data.radio);
    }
}

// ============================================================================
// 🌟 核心：全新 GitHub 日曆熱力圖邏輯
// ============================================================================
// 🌟 在全域宣告一個字典，用來安全地存放 Tooltip 內容
window.heatmapTooltipMap = {};
function openMonthHeatmapModal() {
    if (!masterJsonData || !masterJsonData.records) return;

    const selectedYear = parseInt(document.getElementById('yearSelect').value);
    const selectedMonth = parseInt(document.getElementById('monthSelect').value);
    
    document.getElementById('heatmapTitle').innerHTML = `📅 ${selectedYear} 年 ${selectedMonth} 月 - 全網健康度熱力圖`;

    const today = new Date();
    const offset = today.getTimezoneOffset() * 60000;
    const localDateStr = (new Date(today - offset)).toISOString().split('T')[0];
    const realYear = parseInt(localDateStr.substring(0, 4));
    const realMonth = parseInt(localDateStr.substring(5, 7));
    const realDay = parseInt(localDateStr.substring(8, 10));

    const isCurrentMonth = (selectedYear === realYear && selectedMonth === realMonth);

    const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();

    // 🌟 【關鍵修改】改用全域的乾淨資料，如果沒有就退回使用原始資料
    const targetRecordsForHeatmap = window.currentFilteredRecords || masterJsonData.records;

    let firstDayOfWeek = new Date(selectedYear, selectedMonth - 1, 1).getDay();
    let emptyPrefix = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1; 

    const dailyStats = {};
    targetRecordsForHeatmap.forEach(r => {
        const d = r.met_date;
        if (!d) return;
        
        if (!dailyStats[d]) {
            dailyStats[d] = { 
                stations: new Set(), 
                items: {},
                totalCount: 0,
                levelB: 0,
                levelC: 0,
                stationDetails: {} // 🌟 升級：用來記住每站的詳細死因
            };
        }
        
        dailyStats[d].stations.add(r.ID);
        dailyStats[d].totalCount++;
        
        const confLevel = (r.Confidence_Level || '').toUpperCase();
        if (confLevel === 'B') dailyStats[d].levelB++;
        if (confLevel === 'C') dailyStats[d].levelC++;

        const item = r.ObsItem || '未知';
        dailyStats[d].items[item] = (dailyStats[d].items[item] || 0) + 1;

        // 🌟 升級：紀錄每站當天發生了幾次，以及是「哪些項目」壞掉
        const stInfo = stationNameMap[r.ID] || { name: r.ID, owner: "未知單位" };
        const stKey = `${stInfo.name} (${r.ID})`;
        if (!dailyStats[d].stationDetails[stKey]) {
            dailyStats[d].stationDetails[stKey] = { count: 0, itemTally: {} };
        }
        dailyStats[d].stationDetails[stKey].count++;
        dailyStats[d].stationDetails[stKey].itemTally[item] = (dailyStats[d].stationDetails[stKey].itemTally[item] || 0) + 1;
    });

    const grid = document.getElementById('heatmapGrid');
    grid.innerHTML = ''; 
    window.heatmapTooltipMap = {}; 

    const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
    weekdays.forEach(day => {
        grid.innerHTML += `<div class="heatmap-header">${day}</div>`;
    });

    for (let i = 0; i < emptyPrefix; i++) {
        grid.innerHTML += `<div class="heatmap-cell empty-cell"></div>`;
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const dayStr = day.toString().padStart(2, '0');
        const fullDateStr = `${selectedYear}-${selectedMonth.toString().padStart(2, '0')}-${dayStr}`;
        
        let isFuture = false;
        if (isCurrentMonth && day > realDay) {
            isFuture = true;
        } else if (selectedYear > realYear || (selectedYear === realYear && selectedMonth > realMonth)) {
            isFuture = true;
        }

        if (isFuture) {
            grid.innerHTML += `<div class="heatmap-cell future-day">${day}</div>`;
            continue;
        }

        let stationCount = 0;
        let tooltipHTML = '';

        if (dailyStats[fullDateStr]) {
            stationCount = dailyStats[fullDateStr].stations.size;
            const total = dailyStats[fullDateStr].totalCount;
            const bCnt = dailyStats[fullDateStr].levelB;
            const cCnt = dailyStats[fullDateStr].levelC;

            const sortedItems = Object.entries(dailyStats[fullDateStr].items).sort((a,b) => b[1] - a[1]);
            const topItemStr = sortedItems.length > 0 ? `${sortedItems[0][0]} (${sortedItems[0][1]}筆)` : '無';

            // 🌟 升級：找出當天最雷的前 3 名測站，並標上他們各自專屬的「最大戰犯項目」
            const sortedStations = Object.entries(dailyStats[fullDateStr].stationDetails).sort((a,b) => b[1].count - a[1].count).slice(0, 3);
            let topStationsStr = sortedStations.map((s, idx) => {
                const stName = s[0];
                const stCount = s[1].count;
                // 從這站的 itemTally 裡抓出發生最多次的項目
                const stTopItem = Object.entries(s[1].itemTally).sort((a,b) => b[1] - a[1])[0][0];
                
                return `
                    <div style="margin-top:5px; display:flex; justify-content:space-between; align-items:center;">
                        <div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width: 140px;">
                            <span style="color:#aaa;">${idx+1}.</span> ${stName}
                        </div>
                        <div style="text-align:right;">
                            <span style="background: rgba(255,193,7,0.2); color:#ffc107; padding:2px 5px; border-radius:3px; font-size:11px; margin-right:4px;">${stTopItem}</span>
                            <span style="color:#ffc107;font-size:12px;">[${stCount}筆]</span>
                        </div>
                    </div>
                `;
            }).join('');

            tooltipHTML = `
                <div style="font-size: 16px; font-weight:bold; margin-bottom:6px; border-bottom:1px solid #555; padding-bottom:4px;">
                    🚨 ${fullDateStr}
                </div>
                <div style="margin-bottom:4px;">
                    總計 <strong>${stationCount}</strong> 站發生異常 (共 <strong>${total}</strong> 筆)
                </div>
                <div style="font-size: 13px; color: #ccc; margin-bottom:6px;">
                    🔴 C級: ${cCnt} 筆 | 🟡 B級: ${bCnt} 筆
                </div>
                <div style="color: #ffc107; margin-bottom:8px;">
                    ⚠️ 單日最大宗項目：${topItemStr}
                </div>
                <div style="font-size: 13px; background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; min-width: 260px;">
                    <div style="color:#9be9a8; margin-bottom:4px; font-weight:bold; border-bottom:1px dashed #555; padding-bottom:4px;">📍 焦點異常站點與主因：</div>
                    ${topStationsStr}
                </div>
            `;
        } else {
            tooltipHTML = `
                <div style="font-size: 16px; font-weight:bold; margin-bottom:4px;">
                    ✅ ${fullDateStr}
                </div>
                <div style="color: #9be9a8; margin-top:3px;">
                    全網運作良好，無任何異常記錄！
                </div>
            `;
        }

        window.heatmapTooltipMap[fullDateStr] = tooltipHTML;

        // 🌟 這裡可以隨時更改你的顏色級距門檻
        let levelClass = 'level-0';
        if (stationCount >= 1 && stationCount <= 50) {
            levelClass = 'level-1'; // 🟢 1~50 站出事亮綠燈
        } else if (stationCount >= 51 && stationCount <= 150) {
            levelClass = 'level-2'; // 🟡 51~150 站出事亮黃燈
        } else if (stationCount > 150) {
            levelClass = 'level-3'; // 🔴 151 站以上才准亮紅燈！
        }

        grid.innerHTML += `
            <div class="heatmap-cell ${levelClass}" 
                 onmousemove="showHeatmapTooltip(event, '${fullDateStr}')" 
                 onmouseout="hideHeatmapTooltip()">
                 ${day}
            </div>
        `;
    }

    document.getElementById('monthHeatmapModal').style.display = 'flex';
}



// 📅 計算熱力圖每日異常站數
function updateHeatmapData(filteredData) {
    const dailyStationCount = {};

    // 1. 遍歷過濾後的資料，把同一天的測站 ID 塞進 Set (自動去除重複)
    filteredData.forEach(record => {
        const date = record.met_date;
        if (!date) return;
        
        if (!dailyStationCount[date]) {
            dailyStationCount[date] = new Set();
        }
        dailyStationCount[date].add(record.ID);
    });

    // 2. 將 Set 轉換為數字，得到 { "2026-06-01": 15, "2026-06-02": 8 ... } 這樣的格式
    currentHeatmapData = {};
    for (const date in dailyStationCount) {
        currentHeatmapData[date] = dailyStationCount[date].size;
    }
}

function closeMonthHeatmapModal() {
    document.getElementById('monthHeatmapModal').style.display = 'none';
    hideHeatmapTooltip(); 
}

// 🌟 浮動提示框 (Tooltip) 互動邏輯
// 🌟 修改：接收日期字串，然後去字典裡拿真正的 HTML 出來顯示
function showHeatmapTooltip(event, dateStr) {
    const tooltip = document.getElementById('heatmapTooltip');
    tooltip.innerHTML = window.heatmapTooltipMap[dateStr];
    tooltip.style.display = 'block';
    tooltip.style.left = (event.pageX + 15) + 'px';
    tooltip.style.top = (event.pageY + 15) + 'px';
}

function hideHeatmapTooltip() {
    document.getElementById('heatmapTooltip').style.display = 'none';
}
// ============================================================================

function extractNum(str) {
    let s = String(str);
    if(s.includes('=')) {
        let m = s.match(/=(-?\d+(\.\d+)?)/);
        if(m) return parseFloat(m[1]);
    }
    return parseFloat(s);
}

function applyFilters() {
    if (!masterJsonData || !masterJsonData.records) return;

    const keyword = document.getElementById('searchInput').value.trim().toLowerCase();
    const selectedDate = document.getElementById('dateFilter').value; 
    const selectedLevel = document.getElementById('levelFilter').value;
    const selectedItem = document.getElementById('itemFilter').value;
    const methodKeyword = document.getElementById('methodFilter').value.trim().toLowerCase(); 

    // 🌟 智慧萃取：如果使用者是點擊選單
    let exactSearchId = null;
    const match = keyword.match(/\((.*?)\s*-/); 
    if (match) {
        exactSearchId = match[1].trim().toLowerCase();
    }

    // 🌟 取得開關目前的狀態 (true 代表只要看已上架的)
    const onlyShowPublished = publishToggle ? publishToggle.checked : true;

    let filteredData = masterJsonData.records.filter(record => {
        // 🌟 智慧注入：把對照檔的名稱、所屬單位跟「上架狀態」，一起讀出來！
        const stInfo = stationNameMap[record.ID] || { name: record.ID, owner: "未知單位", publish: 0 };
        record.StationName = stInfo.name;
        record.Owner = stInfo.owner; 

        // 🌟 【關鍵修正】現在是去 stInfo 裡面檢查 publish！
        // 如果開關有開 (只要看上架)，且這個站的 publish 為 0，就剃除！
        if (onlyShowPublished && (stInfo.publish === 0 || stInfo.publish === "0" || stInfo.publish === false)) {
            return false;
        }

        let passKeyword = true;
        
        if (exactSearchId) {
            passKeyword = (record.ID.toLowerCase() === exactSearchId);
        } else if (keyword !== '') {
            passKeyword = (record.ID.toLowerCase().includes(keyword)) ||
                          (record.StationName.toLowerCase().includes(keyword)) ||
                          (record.Radio_id && record.Radio_id.toLowerCase().includes(keyword));
        }
        
        const recordDate = record.met_date ?? '';
        const passDate = (selectedDate === '') || (recordDate === selectedDate);
        const confLevel = (record.Confidence_Level ?? '').toUpperCase();
        const passLevel = (selectedLevel === 'ALL') || (confLevel === selectedLevel);
        const passItem = (selectedItem === 'ALL') || ((record.ObsItem ?? '') === selectedItem);
        const passMethod = (methodKeyword === '') || (record.QC_Method ?? '').toLowerCase().includes(methodKeyword);

        return passKeyword && passDate && passLevel && passItem && passMethod;
    });

    // ▼▼▼ 以下是你原有的排序邏輯 ▼▼▼
    if (currentSortCol) {
        filteredData.sort((a, b) => {
            let valA = a[currentSortCol] ?? '';
            let valB = b[currentSortCol] ?? '';
            if (currentSortCol === 'Obsvalue') {
                let numA = extractNum(valA); let numB = extractNum(valB);
                if (!isNaN(numA) && !isNaN(numB)) { return currentSortAsc ? numA - numB : numB - numA; }
            }
            valA = String(valA).toLowerCase(); valB = String(valB).toLowerCase();
            if (valA < valB) return currentSortAsc ? -1 : 1;
            if (valA > valB) return currentSortAsc ? 1 : -1;
            return 0;
        });
    }

    window.currentFilteredRecords = filteredData; // 🌟 【新增這行】將過濾好的乾淨資料，存放到全域變數中，供所有彈出視窗使用！

    
    updateKPICards(filteredData); // 🌟 在重新繪製表格和圖表之前，先把熱騰騰過濾好的資料餵給 KPI 卡片！
    updateHeatmapData(filteredData); // 🌟 新增這一行：更新熱力圖的數據大腦

    updateCharts(filteredData);
    renderTable(filteredData, (keyword !== '' || selectedDate !== '' || selectedLevel !== 'ALL' || selectedItem !== 'ALL' || methodKeyword !== ''));
    updateURLParams(); // 🌟 新增這一行：過濾完成後，順便把狀態寫進網址裡
}

function animateValue(id, start, end, duration) {
    const obj = document.getElementById(id);
    if (!obj) return;
    if (obj.timer) clearInterval(obj.timer);
    if (start === end) { obj.textContent = end; return; }
    const range = end - start;
    let current = start;
    const increment = end > start ? 1 : -1;
    const stepTime = Math.abs(Math.floor(duration / range));
    const actualStep = Math.max(stepTime, 10); 
    const stepChunk = Math.ceil(Math.abs(range) / (duration / actualStep)) || 1;

    obj.timer = setInterval(function() {
        current += stepChunk * increment;
        if ((increment > 0 && current >= end) || (increment < 0 && current <= end)) {
            obj.textContent = end;
            clearInterval(obj.timer);
            obj.timer = null;
        } else {
            obj.textContent = Math.floor(current);
        }
    }, actualStep);
}

function updateCharts(data) {
    const itemTally = {};
    const stationTally = {};

    data.forEach(r => {
        const item = r.ObsItem || '未知項目';
        itemTally[item] = (itemTally[item] || 0) + 1;
        const stationStr = `${r.StationName || '未知'}(${r.ID || '無ID'})`;
        stationTally[stationStr] = (stationTally[stationStr] || 0) + 1;
    });

    const pieCtx = document.getElementById('itemPieChart').getContext('2d');
    if (pieChartInstance) pieChartInstance.destroy(); 
    
    pieChartInstance = new Chart(pieCtx, {
        type: 'pie', 
        data: {
            labels: Object.keys(itemTally),
            datasets: [{
                data: Object.values(itemTally),
                backgroundColor: ['#ff6384', '#36a2eb', '#ffce56', '#4bc0c0', '#9966ff', '#ff9f40', '#c9cbcf', '#20c997', '#fd7e14'],
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: { display: true, text: '目前篩選之異常觀測項目比例', font: { size: 16 } },
                legend: { position: 'right' }
            }
        }
    });

    const sortedStations = Object.entries(stationTally)
        .sort((a, b) => b[1] - a[1]) 
        .slice(0, 10); 

    const stationLabels = sortedStations.map(s => s[0]);
    const stationDataCount = sortedStations.map(s => s[1]);

    const barCtx = document.getElementById('stationBarChart').getContext('2d');
    if (barChartInstance) barChartInstance.destroy();

    barChartInstance = new Chart(barCtx, {
        type: 'bar',
        data: {
            labels: stationLabels,
            datasets: [{
                label: '異常筆數',
                data: stationDataCount,
                backgroundColor: '#36a2eb',
                borderRadius: 4 
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            onHover: (event, chartElement) => {
                event.native.target.style.cursor = chartElement[0] ? 'pointer' : 'default';
            },
            onClick: (event, elements, chart) => {
                if (elements.length > 0) {
                    const index = elements[0].index;
                    const label = chart.data.labels[index]; 
                    
                    // 🌟 核心修正：改用更嚴格的 Regex，強迫從字串「最尾端」倒回去抓最後一個括弧！
                    // 這樣就能完美把 "金門(東)" 當作名字，"C2W03" 當作 ID 拆開！
                    const match = label.match(/^(.*)\(([^)]+)\)$/);
                    if (match) {
                        const stName = match[1];  // ➔ 拿到漂亮的 "金門(東)"
                        const stID = match[2];    // ➔ 拿到純淨的 "C2W03"
                        
                        let radioId = '未知模組';
                        if (masterJsonData && masterJsonData.records) {
                            const record = masterJsonData.records.find(r => r.ID === stID);
                            if (record) radioId = record.Radio_id || '未知模組';
                        }
                        openStationModal(stID, stName, radioId);
                    }
                }
            },
            plugins: {
                title: { display: true, text: '目前篩選之異常次數 Top 10 測站 (👆 點擊圖柱可看履歷)', font: { size: 16 } },
                legend: { display: false } 
            },
            scales: {
                y: { beginAtZero: true, ticks: { stepSize: 1 } }
            }
        }
    });
}

function formatObsTime(rawTime) {
    if (!rawTime) return '';
    return rawTime.replace(/T/g, ' ').replace(/\+08:00/g, '');
}

// 🌟 宣告一個全域變數，用來暫存現在正在看「哪個站」的所有資料
let currentModalStationRecords = [];

// 1. 負責打開視窗、設定選單
function openStationModal(stationId, stationName, radioId, targetItem = 'ALL') {
    if (!masterJsonData || !masterJsonData.records) return;

    // 🌟 【關鍵修改】改用乾淨資料
    const baseRecords = window.currentFilteredRecords || masterJsonData.records;

    // 把這個站「這個月所有的異常」先存起來，給切換選單用
    currentModalStationRecords = baseRecords.filter(r => r.ID === stationId);
    
    // 找出這個站這個月到底壞了「哪些」項目 (利用 Set 自動去重)
    const uniqueItems = new Set();
    currentModalStationRecords.forEach(r => {
        if (r.ObsItem) uniqueItems.add(r.ObsItem);
    });

    // 準備下拉選單的選項
    const itemSelect = document.getElementById('modalItemSelect');
    itemSelect.innerHTML = '<option value="ALL">🌟 全站總計 (所有項目)</option>';
    uniqueItems.forEach(item => {
        itemSelect.innerHTML += `<option value="${item}">${item} 項目</option>`;
    });

    // 根據傳進來的 targetItem 設定預設值 (如果從卡片點進來，預設就是 ALL)
    if (targetItem && targetItem !== 'ALL' && uniqueItems.has(targetItem)) {
        itemSelect.value = targetItem;
    } else {
        itemSelect.value = 'ALL';
    }

    // 設定左側標題
    document.getElementById('modalStationTitle').innerHTML = `🏥 測站履歷：<strong>${stationName}</strong> (${stationId}) <span style="font-size: 14px; color:#888; margin-left:10px;">模組ID: ${radioId}</span>`;

    // 打開視窗
    document.getElementById('stationModal').style.display = 'flex';

    // 綁定事件：當選單改變時，重新畫圖！
    itemSelect.onchange = renderStationModalChart;

    // 執行第一次畫圖
    renderStationModalChart();
}

// 2. 負責根據「下拉選單的選擇」來重新結算數字與畫折線圖
function renderStationModalChart() {
    const selectedItem = document.getElementById('modalItemSelect').value;
    
    // 根據下拉選單過濾資料
    let filteredRecords = currentModalStationRecords;
    if (selectedItem !== 'ALL') {
        filteredRecords = filteredRecords.filter(r => r.ObsItem === selectedItem);
    }

    let countB = 0; let countC = 0;
    const selectedYear = parseInt(document.getElementById('yearSelect').value);
    const selectedMonth = parseInt(document.getElementById('monthSelect').value);
    const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
    
    const fullMonthDates = [];
    const dateTallyB = {};
    const dateTallyC = {};
    
    for (let i = 1; i <= daysInMonth; i++) {
        const dayStr = i.toString().padStart(2, '0');
        const dateStr = `${selectedYear}-${selectedMonth.toString().padStart(2, '0')}-${dayStr}`;
        fullMonthDates.push(dateStr);
        dateTallyB[dateStr] = 0;
        dateTallyC[dateStr] = 0;
    }

    // 結算過濾後的 B 級與 C 級數量
    filteredRecords.forEach(r => {
        const conf = (r.Confidence_Level || '').toUpperCase();
        const d = r.met_date; 
        if (conf === 'B') { countB++; if (dateTallyB[d] !== undefined) dateTallyB[d]++; } 
        else if (conf === 'C') { countC++; if (dateTallyC[d] !== undefined) dateTallyC[d]++; }
    });

    animateValue("modalCountB", 0, countB, 300);
    animateValue("modalCountC", 0, countC, 300);

    const labels = fullMonthDates.map(d => d.substring(5));
    const dataB = fullMonthDates.map(d => dateTallyB[d]);
    const dataC = fullMonthDates.map(d => dateTallyC[d]);

    const ctx = document.getElementById('modalTrendChart').getContext('2d');
    if (modalTrendChartInstance) modalTrendChartInstance.destroy(); // 刪除舊圖表

    // 畫出新圖表
    modalTrendChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'B 級異常次數 (藍線)',
                    data: dataB,
                    borderColor: '#0d6efd',
                    backgroundColor: 'rgba(13, 110, 253, 0.1)',
                    borderWidth: 2,
                    pointBackgroundColor: '#0d6efd',
                    pointRadius: 3,
                    tension: 0.3,
                    fill: true
                },
                {
                    label: 'C 級異常次數 (紅線)',
                    data: dataC,
                    borderColor: '#dc3545',
                    backgroundColor: 'rgba(220, 53, 69, 0.1)',
                    borderWidth: 2,
                    pointBackgroundColor: '#dc3545',
                    pointRadius: 3,
                    tension: 0.3,
                    fill: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'top' },
                // 標題跟著下拉選單動態變化
                title: { 
                    display: true, 
                    text: selectedItem === 'ALL' ? '本月【全站總體】異常發生頻率趨勢' : `本月【${selectedItem}】項目異常發生頻率趨勢`, 
                    font: {size: 14} 
                },
                tooltip: { mode: 'index', intersect: false } 
            },
            scales: {
                x: { grid: { display: false } },
                y: { beginAtZero: true, ticks: { stepSize: 1 } }
            },
            interaction: { mode: 'nearest', axis: 'x', intersect: false }
        }
    });
}

function closeStationModal() {
    document.getElementById('stationModal').style.display = 'none';
}

// 🌟 全域點擊防呆處理 (新增熱力日曆的關閉判定)
window.onclick = function(event) {
    const stModal = document.getElementById('stationModal');
    const hmModal = document.getElementById('monthHeatmapModal');
    const hrModal = document.getElementById('hourlyChartModal');
    if (event.target == stModal) closeStationModal();
    if (event.target == hmModal) closeMonthHeatmapModal();
    if (event.target == hrModal) closeHourlyChartModal();
}

// ============================================================================
// 🌟 修正版：畫表格函數 (確保 tr.onclick 有正確傳遞 record.ObsItem)
// ============================================================================
function renderTable(dataToRender, expandByDefault = false) {
    const tbody = document.querySelector('#dataTable tbody');
    tbody.innerHTML = ''; 
    groupControllers = [];

    if (dataToRender.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 20px;">找不到符合篩選條件的資料 🔍</td></tr>`;
        return;
    }

    const groupedData = {};
    dataToRender.forEach(record => {
        const dateKey = record.met_date || '未知日期';
        if (!groupedData[dateKey]) {
            groupedData[dateKey] = [];
        }
        groupedData[dateKey].push(record);
    });

    let sortedDates = Object.keys(groupedData);
    let isDateAsc = (currentSortCol === 'ObsTime') ? currentSortAsc : false; 
    sortedDates.sort((a, b) => isDateAsc ? a.localeCompare(b) : b.localeCompare(a));

    const fragment = document.createDocumentFragment();

    sortedDates.forEach(date => {
        const groupRecords = groupedData[date];
        
        let stationTally = {};     
        let stationItemTally = {}; 

        groupRecords.forEach(r => {
            const stID = r.ID || '無ID';
            const stName = r.StationName || '未知測站';
            const stFull = `${stName}(${stID})`; 
            const item = r.ObsItem || '未知';
            const combinedKey = `${stFull}-${item}`;

            stationTally[stFull] = (stationTally[stFull] || 0) + 1;
            stationItemTally[combinedKey] = (stationItemTally[combinedKey] || 0) + 1;
        });

        const topStations = Object.entries(stationTally)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2)
            .map(([name, count]) => `${name} [${count}次]`)
            .join(' 、 ');

        const topStationItems = Object.entries(stationItemTally)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2)
            .map(([combined, count]) => `${combined} [${count}次]`)
            .join(' 、 ');

        let isExpanded = false;
        if (groupStateCache.hasOwnProperty(date)) isExpanded = groupStateCache[date];
        else { isExpanded = expandByDefault; groupStateCache[date] = isExpanded; }

        const groupHeaderTr = document.createElement('tr');
        groupHeaderTr.className = 'group-header';
        const currentIcon = isExpanded ? '▼' : '▶';
        
        groupHeaderTr.innerHTML = `
            <td colspan="11">
                <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 4px 0;">
                    <strong style="font-size: 1.1em; color: #333;"><span class="toggle-icon">${currentIcon}</span> 📅 觀測日期：${date}</strong>
                    <span style="color: #444; font-weight: bold; background: #e9ecef; padding: 2px 8px; border-radius: 4px; font-size: 0.9em;">共 ${groupRecords.length} 筆異常</span>
                    
                    <span style="font-size: 0.88em; background-color: #f1f3f5; padding: 4px 10px; border-radius: 4px; border: 1px solid #ced4da; color: #495057;">
                        📍 <strong>高頻異常站：</strong> ${topStations || '無'}
                    </span>
                    
                    <span style="font-size: 0.88em; background-color: #f1f3f5; padding: 4px 10px; border-radius: 4px; border: 1px solid #ced4da; color: #495057;">
                        🔍 <strong>高頻項目組：</strong> ${topStationItems || '無'}
                    </span>
                </div>
            </td>
        `;
        fragment.appendChild(groupHeaderTr);

        const childRows = [];
        groupRecords.forEach(record => {
            const tr = document.createElement('tr');
            
            tr.className = 'clickable-row'; 
            tr.title = "👆 點擊查看此站本月的健康履歷折線圖";
            
            // 🌟 關鍵修正：這裡要把 record.ObsItem 當作第四個參數傳進去！
            tr.onclick = () => openStationModal(record.ID, record.StationName, record.Radio_id, record.ObsItem);
            
            tr.style.display = isExpanded ? '' : 'none'; 
            const confLevel = (record.Confidence_Level || '').toUpperCase();
            let badgeHtml = '';
            if (confLevel === 'B') badgeHtml = `<span class="badge badge-b">B 級</span>`;
            else if (confLevel === 'C') badgeHtml = `<span class="badge badge-c">C 級</span>`;
            else if (confLevel !== '') badgeHtml = `<span class="badge badge-unknown">${confLevel}</span>`;
            else badgeHtml = `<span>-</span>`;
            
            tr.innerHTML = `
                <td class="nowrap"><strong>${record.ID ?? ''}</strong></td>
                <td class="nowrap" style="color: #0056b3; font-weight: bold;">${record.StationName ?? '未知測站'}</td>
                <td class="nowrap" style="font-family: monospace; font-size: 13px; color: #555;">${record.Radio_id ?? '未知無線電站碼'}</td>
                <td class="nowrap" style="color: #2b7a78; font-weight: bold;">${record.Owner ?? '未知單位'}</td>
                <td class="nowrap">${formatObsTime(record.ObsTime)}</td>
                <td class="nowrap"><span style="background-color: #ffc107; padding: 2px 6px; border-radius: 4px;">${record.ObsItem ?? ''}</span></td>
                <td class="nowrap">${record.Obsvalue ?? ''}</td>
                <td class="nowrap"><strong style="color: #666;">${record.QC_Level ?? ''}</strong></td>
                <td class="nowrap">${badgeHtml}</td>
                <td>${record.QC_Method ?? ''}</td>
                <td>${record.QC_Reason ?? ''}</td>
            `;
            fragment.appendChild(tr);
            childRows.push(tr); 
        });

        const toggleIcon = groupHeaderTr.querySelector('.toggle-icon');
        const toggleGroupState = (forceExpand) => {
            if (forceExpand !== undefined) isExpanded = forceExpand; else isExpanded = !isExpanded;
            groupStateCache[date] = isExpanded; 
            toggleIcon.textContent = isExpanded ? '▼' : '▶';
            childRows.forEach(row => { row.style.display = isExpanded ? '' : 'none'; });
        };

        groupHeaderTr.addEventListener('click', () => toggleGroupState());
        groupControllers.push({
            expand: () => toggleGroupState(true),
            collapse: () => toggleGroupState(false)
        });
    });
    tbody.appendChild(fragment);
}

document.getElementById('btnExpandAll').addEventListener('click', () => { groupControllers.forEach(c => c.expand()); });
document.getElementById('btnCollapseAll').addEventListener('click', () => { groupControllers.forEach(c => c.collapse()); });

const btnClear = document.getElementById('btnClearFilters');
if (btnClear) {
    btnClear.addEventListener('click', () => {
        document.getElementById('searchInput').value = '';
        document.getElementById('dateFilter').value = '';
        document.getElementById('levelFilter').value = 'ALL';
        document.getElementById('itemFilter').value = 'ALL';
        document.getElementById('methodFilter').value = '';
        
        // 🌟 【新增】將 publish 開關恢復為預設狀態 (打勾)
        if (publishToggle) publishToggle.checked = true;

        applyFilters(); 
    });
}

function setupSorting() {
    document.querySelectorAll('th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.getAttribute('data-sort');
            if (currentSortCol === col) currentSortAsc = !currentSortAsc;
            else { currentSortCol = col; currentSortAsc = true; }
            updateSortIcons(); applyFilters(); 
        });
    });
}

function updateSortIcons() {
    document.querySelectorAll('th[data-sort]').forEach(th => {
        const icon = th.querySelector('.sort-icon');
        if (th.getAttribute('data-sort') === currentSortCol) {
            icon.innerHTML = currentSortAsc ? '↑' : '↓'; icon.classList.add('sort-active');
        } else {
            icon.innerHTML = '↕'; icon.classList.remove('sort-active');
        }
    });
}

document.getElementById('yearSelect').addEventListener('change', () => {
    document.getElementById('dateFilter').value = '';
    fetchDashboardData();
});
document.getElementById('monthSelect').addEventListener('change', () => {
    document.getElementById('dateFilter').value = '';
    fetchDashboardData();
});

// ============================================================================
// 🌟 升級版：動態下拉選單與精準搜尋綁定
// ============================================================================
document.getElementById('searchInput').addEventListener('input', (e) => {
    const keyword = e.target.value.trim().toLowerCase();
    const dataList = document.getElementById('stationHintList');
    dataList.innerHTML = ''; 

    if (keyword.length > 0 && masterJsonData && masterJsonData.records) {
        const uniqueOptions = new Set();
        
        masterJsonData.records.forEach(r => {
            // 🌟 因為現在對照檔結構變了，要從 .name 和 .owner 拿資料
            const stInfo = stationNameMap[r.ID] || { name: r.ID, owner: "未知單位" };
            const name = stInfo.name;   // ➔ 確保是純字串站名
            const owner = stInfo.owner; // ➔ 確保是純字串單位
            const id = r.ID.toLowerCase();

            if (name.toLowerCase().includes(keyword) || id.includes(keyword) || owner.toLowerCase().includes(keyword)) {
                // 🌟 改成你要的完美格式：六龜 (C0V810 - 水利署)
                uniqueOptions.add(`${name} (${r.ID} - ${owner})`);
            }
        });

        let count = 0;
        uniqueOptions.forEach(opt => {
            if (count < 50) {
                const option = document.createElement('option');
                option.value = opt;
                dataList.appendChild(option);
                count++;
            }
        });
    }
    debounceApplyFilters();
});
document.getElementById('methodFilter').addEventListener('input', debounceApplyFilters);
document.getElementById('dateFilter').addEventListener('input', applyFilters);
document.getElementById('levelFilter').addEventListener('change', applyFilters);
document.getElementById('itemFilter').addEventListener('change', applyFilters);

window.onload = () => { 
    setupSorting(); 
    updateSortIcons(); 
    
    // 1. 精準抓取今天的在地時間 (防範時區時差)
    const today = new Date();
    const offset = today.getTimezoneOffset() * 60000;
    const localDateStr = (new Date(today - offset)).toISOString().split('T')[0];
    // 2. 萃取當前的年份與月份
    const currentYear = localDateStr.substring(0, 4);  // "2026"
    const currentMonth = localDateStr.substring(5, 7); // "06"
    
    // 3. 核心自動化：動態把下拉選單切換到今天的年月！
    document.getElementById('yearSelect').value = currentYear;
    document.getElementById('monthSelect').value = currentMonth;
    
    // 4. 初始化清除進階日期的篩選框，並開始撈資料
    document.getElementById('dateFilter').value = '';
    fetchDashboardData();

    // ==========================================
    // 🌟 5. 新增：讀取網址參數，覆蓋畫面上的預設狀態
    // ==========================================
    applyURLParamsToFilters();

    // 🌟 6. 防呆機制：如果網址有指定「特定日期」，自動將頂部的「年月選單」切換過去！
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('date')) {
        const urlDate = urlParams.get('date'); // 例如 "2026-05-12"
        if (urlDate && urlDate.length >= 7) {
            const elYear = document.getElementById('yearSelect');
            const elMonth = document.getElementById('monthSelect');
            
            // 加上保護：確定畫面上有這兩個選單才去改變它們的值
            if (elYear) elYear.value = urlDate.substring(0, 4);
            if (elMonth) elMonth.value = urlDate.substring(5, 7);
        }
    }

    // ==========================================
    // 7. 條件全部準備完畢，開始撈資料！
    // ==========================================
    fetchDashboardData();
};
// ============================================================================
// 🌟 新增：24小時戰情爆發圖邏輯 (支援 Stacked Bar 堆疊圖)
// ============================================================================
function openHourlyChartModal() {
    if (!masterJsonData || !masterJsonData.records) return;

    const selectedYear = parseInt(document.getElementById('yearSelect').value);
    const selectedMonth = parseInt(document.getElementById('monthSelect').value);
    
    const today = new Date();
    const offset = today.getTimezoneOffset() * 60000;
    const localDateStr = (new Date(today - offset)).toISOString().split('T')[0];
    const realYear = parseInt(localDateStr.substring(0, 4));
    const realMonth = parseInt(localDateStr.substring(5, 7));
    
    const isCurrentMonth = (selectedYear === realYear && selectedMonth === realMonth);
    // 🌟 【關鍵修改】改用乾淨資料
    const baseRecords = window.currentFilteredRecords || masterJsonData.records;

    let targetRecords = [];
    let chartTitle = "";

    // 智慧判斷：是看「今天」還是看「整個歷史月」
    if (isCurrentMonth) {
        const allDates = baseRecords.map(r => r.met_date).filter(d => d);
        const latestDate = allDates.sort().reverse()[0] || localDateStr; 
        targetRecords = baseRecords.filter(r => r.met_date === latestDate);
        chartTitle = `⏱️ ${latestDate} (本日) - 24 小時戰情爆發分佈圖`;
    } else {
        targetRecords = baseRecords;
        chartTitle = `⏱️ ${selectedYear} 年 ${selectedMonth} 月 - 全月各時段異常加總分佈圖`;
    }

    document.getElementById('hourlyChartTitle').innerHTML = chartTitle;

    // 準備 24 個小時的陣列櫃子
    const hours = Array.from({length: 24}, (_, i) => i.toString().padStart(2, '0'));
    const dataB = new Array(24).fill(0);
    const dataC = new Array(24).fill(0);

    // 把資料丟進對應的小時櫃子裡
    targetRecords.forEach(r => {
        if (!r.ObsTime) return;
        
        let hourStr = '00';
        if (r.ObsTime.includes('T')) {
            hourStr = r.ObsTime.split('T')[1].substring(0, 2);
        } else if (r.ObsTime.includes(' ')) {
            hourStr = r.ObsTime.split(' ')[1].substring(0, 2);
        }
        
        const hourIdx = parseInt(hourStr);
        if (!isNaN(hourIdx) && hourIdx >= 0 && hourIdx <= 23) {
            const conf = (r.Confidence_Level || '').toUpperCase();
            if (conf === 'B') dataB[hourIdx]++;
            else if (conf === 'C') dataC[hourIdx]++;
        }
    });

    document.getElementById('hourlyChartModal').style.display = 'flex';

    const ctx = document.getElementById('hourlyBarChart').getContext('2d');
    if (hourlyBarChartInstance) hourlyBarChartInstance.destroy();

    // 畫出超美的堆疊長條圖
    hourlyBarChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: hours.map(h => `${h}:00`),
            datasets: [
                {
                    label: '🔴 C級 嚴重異常',
                    data: dataC,
                    backgroundColor: '#dc3545',
                    stack: 'Stack 0', // 指定同一個 Stack 就能疊在一起
                },
                {
                    label: '🟡 B級 警告異常',
                    data: dataB,
                    backgroundColor: '#ffc107',
                    stack: 'Stack 0',
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'top' },
                tooltip: { mode: 'index', intersect: false }
            },
            scales: {
                x: { stacked: true },
                y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } }
            }
        }
    });
}

function closeHourlyChartModal() {
    document.getElementById('hourlyChartModal').style.display = 'none';
}
// 📊 更新上方 KPI 卡片的函式
function updateKPICards(filteredData) {
    // 1. 【本月累計異常】直接計算過濾後資料的總筆數
    const monthCount = filteredData.length;
    document.getElementById('kpiMonthCount').innerText = monthCount;

    // 2. 決定「本日」是哪一天：從日期選擇器拿，沒選的話就抓資料裡最新的一天
    const selectedDate = document.getElementById('dateFilter').value;
    let targetDate = selectedDate;
    if (!targetDate && masterJsonData && masterJsonData.records.length > 0) {
        const dates = masterJsonData.records.map(d => d.met_date).filter(Boolean).sort();
        targetDate = dates[dates.length - 1]; 
    }

    // 將資料再縮小範圍到「本日」
    const todayData = filteredData.filter(d => d.met_date === targetDate);

    // 3. 【本日累計異常測站數】計算不重複的測站 ID 數量
    const todayUniqueStations = new Set(todayData.map(d => d.ID)).size;
    document.getElementById('kpiTodayCount').innerText = todayUniqueStations;
    
    if (targetDate) {
        // 更新卡片下方的日期小字
        document.getElementById('kpiTodaySub').innerText = `${targetDate} (共 ${todayData.length} 筆異常)`;
    } else {
        document.getElementById('kpiTodaySub').innerText = '-- 月 -- 日';
    }

    // 4. 【焦點關注】尋找本日發生最多次異常的測站
    const findWorstStation = (level) => {
        // 只抓 B 級或 C 級
        const levelData = todayData.filter(d => (d.Confidence_Level || '').toUpperCase() === level);
        if (levelData.length === 0) return { name: '無資料', count: 0 };
        
        // 統計每個測站的異常次數
        const counts = {};
        levelData.forEach(d => {
            // 使用測站名稱來統計
            counts[d.StationName] = (counts[d.StationName] || 0) + 1;
        });
        
        // 找出最大值
        let worstName = '無資料';
        let maxCount = 0;
        for (const [name, count] of Object.entries(counts)) {
            if (count > maxCount) {
                maxCount = count;
                worstName = name;
            }
        }
        return { name: worstName, count: maxCount };
    };

    // 更新 B 級卡片
    const worstB = findWorstStation('B');
    document.getElementById('kpiWorstStationB').innerText = worstB.name;
    document.getElementById('kpiWorstCountB').innerText = `共發生 ${worstB.count} 次異常`;

    // 更新 C 級卡片
    const worstC = findWorstStation('C');
    document.getElementById('kpiWorstStationC').innerText = worstC.name;
    document.getElementById('kpiWorstCountC').innerText = `共發生 ${worstC.count} 次異常`;
}

// 🔗 將目前的過濾條件寫入網址
function updateURLParams() {
    const url = new URL(window.location);
    
    // 讀取目前畫面上的過濾條件 (修正 ID 為 searchInput)
    const date = document.getElementById('dateFilter').value;
    const level = document.getElementById('levelFilter').value;
    const item = document.getElementById('itemFilter').value;
    const keyword = document.getElementById('searchInput').value; 
    const publish = document.getElementById('publishToggle').checked;

    // 設定網址參數
    if (date) url.searchParams.set('date', date);
    else url.searchParams.delete('date');

    if (level !== 'ALL') url.searchParams.set('level', level);
    else url.searchParams.delete('level');

    if (item !== 'ALL') url.searchParams.set('item', item);
    else url.searchParams.delete('item');

    if (keyword) url.searchParams.set('keyword', keyword);
    else url.searchParams.delete('keyword');

    if (publish) url.searchParams.set('publish', '1');
    else url.searchParams.delete('publish');

    window.history.replaceState({}, '', url);
}

// 🔗 網頁載入時，從網址讀取過濾條件並還原畫面 (安全防呆版)
function applyURLParamsToFilters() {
    const urlParams = new URLSearchParams(window.location.search);

    const elDate = document.getElementById('dateFilter');
    if (elDate && urlParams.has('date')) elDate.value = urlParams.get('date');

    const elLevel = document.getElementById('levelFilter');
    if (elLevel && urlParams.has('level')) elLevel.value = urlParams.get('level');

    const elItem = document.getElementById('itemFilter');
    if (elItem && urlParams.has('item')) elItem.value = urlParams.get('item');

    // (修正 ID 為 searchInput)
    const elKeyword = document.getElementById('searchInput');
    if (elKeyword && urlParams.has('keyword')) elKeyword.value = urlParams.get('keyword');

    const elPublish = document.getElementById('publishToggle');
    if (elPublish && urlParams.has('publish')) {
        elPublish.checked = (urlParams.get('publish') === '1');
    }
}

// 🔗 網頁載入時，從網址讀取過濾條件並還原畫面(安全防呆版)
function applyURLParamsToFilters() {
    const urlParams = new URLSearchParams(window.location.search);

    // 1. 日期選擇器
    const elDate = document.getElementById('dateFilter');
    if (elDate && urlParams.has('date')) {
        elDate.value = urlParams.get('date');
    }

    // 2. 等級下拉選單
    const elLevel = document.getElementById('levelFilter');
    if (elLevel && urlParams.has('level')) {
        elLevel.value = urlParams.get('level');
    }

    // 3. 觀測項目下拉選單
    const elItem = document.getElementById('itemFilter');
    if (elItem && urlParams.has('item')) {
        elItem.value = urlParams.get('item');
    }

    // 4. 文字搜尋框
    const elKeyword = document.getElementById('keywordSearch');
    if (elKeyword && urlParams.has('keyword')) {
        elKeyword.value = urlParams.get('keyword');
    }

    // 5. 上架測站開關
    const elPublish = document.getElementById('publishToggle');
    if (elPublish && urlParams.has('publish')) {
        elPublish.checked = (urlParams.get('publish') === '1');
    }
}
