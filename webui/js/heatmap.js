/* webui/js/heatmap.js */
async function loadNotificationHeatmap(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    renderHeatmapSkeleton(container);

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await fetch('/api/notifications/stats?years=1');
            if (!response.ok) {
                if (response.status === 429 && attempt < maxAttempts) {
                    const ra = parseInt(response.headers.get('Retry-After'), 10);
                    const waitMs = Math.min((ra > 0 ? ra : attempt * 2) * 1000, 30000);
                    await new Promise(r => setTimeout(r, waitMs));
                    continue;
                }
                throw new Error('API error ' + response.status);
            }
            const stats = await response.json();
            renderHeatmap(container, stats);
            return;
        } catch (e) {
            if (attempt === maxAttempts) {
                console.error('Failed to load heatmap:', e);
                container.innerHTML = '<p style="font-size: 11px; color: #888; text-align: center;">統計データの読み込みに失敗しました</p>';
                return;
            }
            await new Promise(r => setTimeout(r, attempt * 2000));
        }
    }
}

function renderHeatmap(container, stats) {
    container.classList.remove('is-loading');
    const now = new Date();
    // 364 days ago (approx 1 year)
    const startDate = new Date();
    startDate.setDate(now.getDate() - 364);
    
    // Adjust to previous Sunday to align grid rows (Sun-Sat)
    const startDay = startDate.getDay();
    startDate.setDate(startDate.getDate() - startDay);
    
    // 実際の実績（本日分まで）を含めた週数を計算
    const dayDiff = Math.floor((now - startDate) / (24 * 3600 * 1000));
    const actualWeeks = Math.ceil((dayDiff + 1) / 7);

    let html = '<div class="heatmap-flex">';
    
    // Day labels
    html += '<div class="heatmap-row-labels">';
    const dayLabelsShort = ['日', '月', '火', '水', '木', '金', '土'];
    dayLabelsShort.forEach((label, i) => {
        if (i % 2 === 0) {
            html += `<span>${label}</span>`;
        } else {
            html += '<span></span>';
        }
    });
    html += '</div>';

    html += '<div class="heatmap-scroll-container">';
    
    // Month labels
    html += `<div class="heatmap-month-labels" style="--hm-weeks: ${actualWeeks};">`;
    const monthNames = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    let lastMonth = -1;
    const tempDate = new Date(startDate);
    for (let w = 0; w < actualWeeks; w++) {
        const m = tempDate.getMonth();
        if (m !== lastMonth) {
            if (w < actualWeeks - 1) {
                html += `<span style="grid-column: span 2">${monthNames[m]}</span>`;
                lastMonth = m;
                w++; 
                tempDate.setDate(tempDate.getDate() + 7); 
            } else {
                html += `<span>${monthNames[m]}</span>`;
                lastMonth = m;
            }
        } else {
            html += '<span></span>';
        }
        tempDate.setDate(tempDate.getDate() + 7);
    }
    html += '</div>';

    html += `<div class="heatmap-container" style="--hm-weeks: ${actualWeeks};">`;

    const currentDate = new Date(startDate);
    const dayCount = actualWeeks * 7;
    for (let i = 0; i < dayCount; i++) {
        const y = currentDate.getFullYear();
        const m = String(currentDate.getMonth() + 1).padStart(2, '0');
        const d = String(currentDate.getDate()).padStart(2, '0');
        const dateStr = `${y}-${m}-${d}`;

        const isFuture = currentDate > now;
        
        if (isFuture) {
            html += '<div class="heatmap-cell future" style="visibility: hidden;"></div>';
        } else {
            const count = stats[dateStr] || 0;
            const level = getLevel(count);
            html += `<div class="heatmap-cell level-${level}" 
                         data-date="${dateStr}" 
                         data-count="${count}"></div>`;
        }
        
        currentDate.setDate(currentDate.getDate() + 1);
    }

    html += '</div>'; // .heatmap-container
    html += '</div>'; // overflow container
    html += '</div>'; // .heatmap-flex
    
    // Legend
    html += `
        <div class="heatmap-footer" style="display: flex; justify-content: flex-end; margin-top: 10px;">
            <div class="heatmap-legend">
                <span>少ない</span>
                <div class="legend-cells">
                    <div class="legend-cell level-0"></div>
                    <div class="legend-cell level-1"></div>
                    <div class="legend-cell level-2"></div>
                    <div class="legend-cell level-3"></div>
                    <div class="legend-cell level-4"></div>
                </div>
                <span>多い</span>
            </div>
        </div>
    `;

    container.innerHTML = html;
    
    const scroller = container.querySelector('.heatmap-scroll-container');
    if (scroller) {
        scroller.scrollLeft = scroller.scrollWidth;
        // メニュー開閉やジェスチャーとの干渉を防止
        scroller.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
        scroller.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
    }

    setupTooltip(container);
}

function getLevel(count) {
    if (count === 0) return 0;
    if (count <= 3) return 1;
    if (count <= 7) return 2;
    if (count <= 15) return 3;
    return 4;
}

function setupTooltip(container) {
    let tooltip = document.getElementById('heatmap-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'heatmap-tooltip';
        tooltip.className = 'heatmap-tooltip';
        tooltip.style.display = 'none';
        document.body.appendChild(tooltip);
    }

    container.addEventListener('mouseover', (e) => {
        if (e.target.classList.contains('heatmap-cell')) {
            const date = e.target.getAttribute('data-date');
            const count = e.target.getAttribute('data-count');
            tooltip.innerHTML = `<strong>${count} 件の通知</strong><br>${date}`;
            tooltip.style.display = 'block';
            
            const rect = e.target.getBoundingClientRect();
            tooltip.style.left = `${rect.left + rect.width / 2 + window.scrollX}px`;
            tooltip.style.top = `${rect.top + window.scrollY}px`;
        }
    });

    container.addEventListener('mouseout', () => {
        tooltip.style.display = 'none';
    });
}

function renderHeatmapSkeleton(container) {
    container.classList.add('is-loading');
    const weeks = 53; // Approx 1 year
    let html = '<div class="heatmap-flex">';
    
    // Day labels skeleton
    html += '<div class="heatmap-row-labels">';
    for (let i = 0; i < 7; i++) {
        html += i % 2 === 0 ? '<span class="skeleton" style="width: 12px;"></span>' : '<span></span>';
    }
    html += '</div>';
    
    html += '<div class="heatmap-scroll-container">';
    
    // Month labels skeleton
    html += `<div class="heatmap-month-labels" style="--hm-weeks: ${weeks};">`;
    for (let w = 0; w < weeks; w++) {
        if (w % 4 === 0) html += '<span class="skeleton" style="grid-column: span 2; width: 24px;"></span>';
        else if (w % 4 !== 1) html += '<span></span>';
    }
    html += '</div>';
    
    html += `<div class="heatmap-container" style="--hm-weeks: ${weeks};">`;
    for (let i = 0; i < weeks * 7; i++) {
        html += '<div class="heatmap-cell skeleton"></div>';
    }
    html += '</div>';
    html += '</div>';
    html += '</div>';
    
    container.innerHTML = html;
    
    const scroller = container.querySelector('.heatmap-scroll-container');
    if (scroller) {
        scroller.scrollLeft = scroller.scrollWidth;
    }
}
