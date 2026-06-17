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
    
    tbody.innerHTML = '<tr><td colspan="10" style="text-align: center;">載入資料中...</td></tr>';
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

function calculateStaticKPIs(filteredRecords = null) {
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

    // 🌟 關鍵修改：如果有過濾後的資料就用過濾後的，否則用原始全月資料  
    const monthRecords = filteredRecords ? filteredRecords : masterJsonData.records;
    
    const uniqueMonthStations = new Set(monthRecords.map(r => r.ID)).size;
    const monthDenominator = masterJsonData.summary.total_active_stations || 0;
    const monthRate = monthDenominator > 0 ? ((uniqueMonthStations / monthDenominator) * 100).toFixed(1) : '0.0';

    let targetRecordsForFocus = [];

    if (isCurrentMonth) {
        // 🌟 這裡也改成從過濾後的資料裡去找最新日期
        const allDates = monthRecords.map(r => r.met_date).filter(d => d);
        // 防呆：如果過濾後這筆資料空了，就給它今天日期  
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

    // 🌟 使用 animateValue 或是直接更換內容，確保能動態反映過濾後的次數與站名  
    document.getElementById('kpiWorstStationB').textContent = worstBStr;
    document.getElementById('kpiWorstCountB').innerHTML = worstBCount > 0 ? `發生 ${worstBCount} 次 | <span style="background:#e9ecef; color:#0056b3; padding:2px 6px; border-radius:3px;">主項目: ${worstBItem}</span>` : '無異常';
    
    document.getElementById('kpiWorstStationC').textContent = worstCStr;
    document.getElementById('kpiWorstCountC').innerHTML = worstCCount > 0 ? `發生 ${worstCCount} 次 | <span style="background:#f8d7da; color:#dc3545; padding:2px 6px; border-radius:3px;">主項目: ${worstCItem}</span>` : '無異常';

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
                stationDetails: {} 
            };
        }
        
        dailyStats[d].stations.add(r.ID);
        dailyStats[d].totalCount++;
        
        const confLevel = (r.Confidence_Level || '').toUpperCase();
        if (confLevel === 'B') dailyStats[d].levelB++;
        if (confLevel === 'C') dailyStats[d].levelC++;

        const item = r.ObsItem || '未知';
        dailyStats[d].items[item] = (dailyStats[d].items[item] || 0) + 1;

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

            const sortedStations = Object.entries(dailyStats[fullDateStr].stationDetails).sort((a,b) => b[1].count - a[1].count).slice(0, 3);
            let topStationsStr = sortedStations.map((s, idx) => {
                const stName = s[0];
                const stCount = s[1].count;
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
            levelClass = 'level-1'; 
        } else if (stationCount >= 51 && stationCount <= 150) {
            levelClass = 'level-2'; 
        } else if (stationCount > 150) {
            levelClass = 'level-3'; 
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

    updateMethodHints(filteredData); // 🌟 核心：根據「過濾後的結果」來動態更新提示清單！

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


  
    calculateStaticKPIs(filteredData); // ⭕ 改成直接呼叫更新後的 calculateStaticKPIs，把過濾後的乾淨資料傳進去！
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
                title: { 
                    display: true, 
                    text: ['目前篩選之異常觀測項目比例', `📊 當前總異常數: ${data.length} 筆`], 
                    font: { size: 15 } 
                },
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
                title: { 
                    display: true, 
                    text: ['🏆 目前篩選之異常次數 Top 10 測站', `📊 當前總異常數: ${data.length} 筆`], 
                    font: { size: 15 } 
                },
                legend: { display: false } 
            },
            scales: {
                y: { beginAtZero: true, ticks: { stepSize: 1 } }
            }
        }
    });
}

// 🧩 動態生成「未通過檢核」的提示清單
function updateMethodHints(data) {
    const datalist = document.getElementById('methodHintList');
    if (!datalist) return;

      // 1. 利用 Set 來自動過濾掉重複的檢核原因
    const uniqueMethods = new Set();
    data.forEach(record => {
        if (record.QC_Method) {
          // 可以根據需求把字串做一點清理，避免前後有空白
            uniqueMethods.add(record.QC_Method.trim());
        }
    });

      // 2. 清空舊的清單
    datalist.innerHTML = '';
      // 3. 把收集到的原因變成 <option> 塞進清單裡
    uniqueMethods.forEach(method => {
        const option = document.createElement('option');
        option.value = method;
        datalist.appendChild(option);
    });
}

function formatObsTime(rawTime) {
    if (!rawTime) return '';
    return rawTime.replace(/T/g, ' ').replace(/\+08:00/g, '');
}

// 🌟 宣告全域變數，用來暫存現在正在看「哪個站」的資料與名稱
let currentModalStationRecords = [];
let currentModalStationName = "";

// 1. 負責打開視窗、設定選單
function openStationModal(stationId, stationName, radioId, targetItem = 'ALL') {
    if (!masterJsonData || !masterJsonData.records) return;

      // 🌟 【關鍵修改】改用乾淨資料
    const baseRecords = window.currentFilteredRecords || masterJsonData.records;
      // 把這個站「這個月所有的異常」先存起來，給切換選單用
    currentModalStationRecords = baseRecords.filter(r => r.ID === stationId);

    // 🌟 新增這行：記住目前的測站名稱，等一下畫圖要用！
    currentModalStationName = `${stationName} (${stationId})`
    
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
    if (modalTrendChartInstance) modalTrendChartInstance.destroy();  // 刪除舊圖表

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
            // 🌟 新增這一段 layout 設定，強制底部留白 20px
            layout: {
                padding: {
                    bottom: 20
                }
            },
            plugins: {
                legend: { position: 'top' },
                // 🌟 關鍵修改：利用陣列產生多行標題，把測站名稱和數量直接畫在畫布裡！
                title: { 
                    display: true, 
                    text: [
                        `🏥 測站：${currentModalStationName}`,
                        selectedItem === 'ALL' ? '本月【全站總體】異常趨勢' : `本月【${selectedItem}】項目異常趨勢`,
                        `📊 期間累計 ➔ B級: ${countB} 次 | C級: ${countC} 次`
                    ],
                    font: {size: 15} 
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
const elSearchInput = document.getElementById('searchInput');

// 保留 input 事件用來建立 datalist
elSearchInput.addEventListener('input', (e) => {
    const keyword = e.target.value.trim().toLowerCase();
    const dataList = document.getElementById('stationHintList');
    dataList.innerHTML = ''; 

    if (keyword.length > 0 && masterJsonData && masterJsonData.records) {
        const uniqueOptions = new Set();
        masterJsonData.records.forEach(r => {
              // 🌟 因為現在對照檔結構變了，要從 .name 和 .owner 拿資料
            const stInfo = stationNameMap[r.ID] || { name: r.ID, owner: "未知單位" };
            const name = stInfo.name;   
            const owner = stInfo.owner; 
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

// 🌟 關鍵修正：加入 change 監聽器，確保滑鼠點擊 datalist 項目時能 100% 被捕捉到
elSearchInput.addEventListener('change', applyFilters);
document.getElementById('methodFilter').addEventListener('change', applyFilters);

// 🌟 關鍵修正：將日期和等級的過濾事件改為 change
document.getElementById('dateFilter').addEventListener('change', applyFilters);
document.getElementById('levelFilter').addEventListener('change', applyFilters);
document.getElementById('itemFilter').addEventListener('change', applyFilters);

// ==========================================
// 🌟 修正：系統啟動的生命週期 (解決還原預設網址問題)
// ==========================================
window.onload = async () => { 
    setupSorting(); 
    updateSortIcons(); 
    
    // 1. 初始化系統預設年月
    const today = new Date();
    const offset = today.getTimezoneOffset() * 60000;
    const localDateStr = (new Date(today - offset)).toISOString().split('T')[0];
    const currentYear = localDateStr.substring(0, 4);  // "2026"
    const currentMonth = localDateStr.substring(5, 7); // "06"
    
    const elYear = document.getElementById('yearSelect');
    const elMonth = document.getElementById('monthSelect');
    
    if (elYear) elYear.value = currentYear;
    if (elMonth) elMonth.value = currentMonth;

    // 2. 🌟 如果網址有帶特定日期，強制將頂部的「年月選單」切換過去
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('date')) {
        const urlDate = urlParams.get('date'); 
        if (urlDate && urlDate.length >= 7) {
            if (elYear) elYear.value = urlDate.substring(0, 4);
            if (elMonth) elMonth.value = urlDate.substring(5, 7);
        }
    }
    
    // 3. 把網址參數填回畫面中的搜尋框與過濾器 (這步要趕在取資料之前)
    applyURLParamsToFilters();

    // 4. 等待網址狀態還原後，才開始向伺服器要資料
    // (fetchDashboardData 執行成功後，最後面會自動呼叫 applyFilters())
    await fetchDashboardData();
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
    // 🌟 新增這兩行：算出這張圖的 B 級與 C 級總數量
    const totalB = dataB.reduce((a, b) => a + b, 0);
    const totalC = dataC.reduce((a, b) => a + b, 0);

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
                    stack: 'Stack 0', 
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
            layout: {
                padding: {
                    bottom: 20
                }
            },
            plugins: {
                legend: { position: 'top' },
                // 🌟 把標題和數量也塞進 24 小時作息圖的畫布裡！
                title: {
                    display: true,
                    text: [
                        chartTitle,
                        `📊 總計 ➔ B級: ${totalB} 次 | C級: ${totalC} 次`
                    ],
                    font: { size: 15 }
                },
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

// 🔗 將目前的過濾條件寫入網址
function updateURLParams() {
    const url = new URL(window.location.href);
    
    const date = document.getElementById('dateFilter').value;
    const level = document.getElementById('levelFilter').value;
    const item = document.getElementById('itemFilter').value;
    let keyword = document.getElementById('searchInput').value.trim(); 
    const publish = document.getElementById('publishToggle').checked;

    // 🌟 智慧萃取：如果 keyword 包含中文與括號 (例如 "六龜 (C0V810 - 水利署)")，只提取乾淨的 ID (C0V810)
    const match = keyword.match(/\((.*?)\s*-/);
    if (match) {
        keyword = match[1].trim(); 
    }
    
      // 設定網址參數
    if (date) url.searchParams.set('date', date);
    else url.searchParams.delete('date');

    if (level && level !== 'ALL') url.searchParams.set('level', level);
    else url.searchParams.delete('level');

    if (item && item !== 'ALL') url.searchParams.set('item', item);
    else url.searchParams.delete('item');

    if (keyword) url.searchParams.set('keyword', keyword);
    else url.searchParams.delete('keyword');

    if (publish) url.searchParams.set('publish', '1');
    else url.searchParams.delete('publish');

    // 🌟 使用 url.search 只附加乾淨的參數字串，不會產生多餘的轉碼
    window.history.replaceState({}, '', url.pathname + url.search);
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

    const elKeyword = document.getElementById('searchInput');
    if (elKeyword && urlParams.has('keyword')) elKeyword.value = urlParams.get('keyword');

    const elPublish = document.getElementById('publishToggle');
    if (elPublish && urlParams.has('publish')) {
        elPublish.checked = (urlParams.get('publish') === '1');
    }
}

// 📥 匯出目前畫面上的過濾結果為 CSV
function exportToCSV() {
// 1. 抓取我們剛剛辛苦建立的「乾淨資料庫」
    const data = window.currentFilteredRecords;
    
    if (!data || data.length === 0) {
        alert("⚠️ 目前畫面上沒有資料可以匯出喔！");
        return;
    }

// 2. 定義 Excel 標題列
    const headers = [
        "測站 ID", "測站名稱", "無線電站碼", "所屬單位", 
        "觀測時間", "異常項目", "觀測值", "檢核結果", 
        "檢核等級", "未通過檢核", "說明"
    ];

// 3. 處理字串的安全小工具 (防止欄位裡有逗號或引號，導致 Excel 欄位大亂)
    const escapeCSV = (str) => {
        if (str === null || str === undefined) return '""';
        const text = String(str).replace(/"/g, '""'); 
        return `"${text}"`; 
    };

// 4. 將每一筆資料轉成 CSV 格式的一行
    const csvRows = data.map(record => {
        return [
            escapeCSV(record.ID),
            escapeCSV(record.StationName),
            escapeCSV(record.Radio_id),
            escapeCSV(record.Owner),
            escapeCSV(record.ObsTime),
            escapeCSV(record.ObsItem),
            escapeCSV(record.Obsvalue),
            escapeCSV(record.QC_Level), 
            escapeCSV(record.Confidence_Level),
            escapeCSV(record.QC_Method),
            escapeCSV(record.QC_Reason)
        ].join(",");
    });

// 5. 組合：加入 \uFEFF (BOM) 讓微軟 Excel 認得 UTF-8 中文，不會變亂碼！
    const csvContent = "\uFEFF" + headers.join(",") + "\n" + csvRows.join("\n");
// 6. 建立虛擬下載連結並觸發點擊
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    
// 產生動態檔名 (例如：QC異常報案清單_2026-06-17.csv)
    const todayStr = new Date().toISOString().split('T')[0];
    link.setAttribute("href", url);
    link.setAttribute("download", `QC異常報案清單_${todayStr}.csv`);
    
// 偷偷加進網頁 -> 點擊下載 -> 拔除
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// ==========================================
// 🌟 新增功能：圖表下載神器 (自帶白底防護)
// ==========================================
function downloadChart(canvasId, fileNamePrefix) {
    const originalCanvas = document.getElementById(canvasId);
    if (!originalCanvas) {
        alert('⚠️ 找不到可下載的圖表！');
        return;
    }

    // 建立一個暫存的畫布，用來填補白色背景 (防止下載後變成透明或黑底)
    const tempCanvas = document.createElement('canvas');
    const ctx = tempCanvas.getContext('2d');
    tempCanvas.width = originalCanvas.width;
    tempCanvas.height = originalCanvas.height;

    // 填滿白色背景
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

    // 把原本圖表的內容完美疊加到白底上
    ctx.drawImage(originalCanvas, 0, 0);

    // 壓上今天的日期
    const dateStr = new Date().toISOString().split('T')[0]; 
    
    // 建立虛擬連結並觸發下載
    const link = document.createElement('a');
    link.download = `${fileNamePrefix}_${dateStr}.png`;
    link.href = tempCanvas.toDataURL('image/png');
    link.click();
}