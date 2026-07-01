import { saveGameState, loadGameState, clearGameStorage, defaultRiichiSession, startingScoreForMode } from './store.js';
import {
    isRiichiMode,
    playerCountForMode,
    formatHandLabel,
    advanceAfterWin,
    advanceAfterRyukyoku,
    notenPenaltyDeltas,
    seatWindForSeat,
    sanmaAbsentSeat,
    RIICHI_DEPOSIT,
} from './riichi/session.js';
import {
    computeRiichiSettlement,
    SCORE_PRESETS,
    buildWinSummary,
    FU_STEPS,
    FU_HINTS,
    MAX_FAN,
    MAX_YAKUMAN,
    formatYakumanLabel,
} from './riichi/settle.js';
import {
    optimalScaleFromMax,
    findMaxScaleByProbe,
    debounce,
    cardOffsetForScale,
    applyCardOffsets,
} from './layout-scale.js';

function formatScoreTierLabel(fan, fu, yakuman, rule = {}) {
    if (yakuman) return formatYakumanLabel(fan);
    if (fan >= 13) return '累计役满';
    if (fan >= 11) return '三倍满';
    if (fan >= 8) return '倍满';
    if (fan >= 6) return '跳满';
    if (fan >= 5) return '满贯';
    if (fan <= 0) return '—';
    const raw = fu * (1 << (2 + fan));
    if (rule.kiriageMangan && raw === 1920) return '切上满贯';
    return `${fan}番${fu}符`;
}

function isScorePresetActive(preset, current) {
    return (
        !!preset.yakuman === !!current.yakuman
        && preset.fan === current.fan
        && (preset.yakuman || preset.fu === current.fu)
    );
}

const { createApp, ref, computed, onMounted, onUnmounted, watch, nextTick } = Vue;

// 数字滚动组件
const CountUp = {
    props: ['to'],
    template: '<span :class="colorClass">{{ displayValue }}</span>',
    setup(props) {
        const displayValue = ref(props.to);
        const colorClass = ref('');
        let animationFrame;
        let timeout;

        watch(() => props.to, (newVal, oldVal) => {
            const start = oldVal || 0;
            const end = newVal;
            
            // Set color based on change direction
            if (end > start) {
                colorClass.value = 'score-changed-pos';
            } else if (end < start) {
                colorClass.value = 'score-changed-neg';
            }
            
            // Reset color after animation (approx 1s + buffer)
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout(() => {
                colorClass.value = '';
            }, 1500);

            const duration = Math.abs(end - start) >= 5000 ? 1000 : Math.abs(end - start) >= 500 ? 600 : 250;
            let startTime = null;

            const animate = (timestamp) => {
                if (!startTime) startTime = timestamp;
                const progress = Math.min((timestamp - startTime) / duration, 1);
                const ease = 1 - Math.pow(1 - progress, 4); // easeOutQuart
                displayValue.value = Math.floor(progress * (end - start) + start);

                if (progress < 1) {
                    animationFrame = requestAnimationFrame(animate);
                } else {
                    displayValue.value = end;
                }
            };
            cancelAnimationFrame(animationFrame);
            animationFrame = requestAnimationFrame(animate);
        });

        return { displayValue, colorClass };
    }
};

createApp({
    components: { CountUp },
    setup() {
        // --- State ---
        const isDark = ref(false);
        const isLocked = ref(false); // 锁定状态
        const players = ref([]); // { name, score }
        const seats = ref([null, null, null, null]); // names
        const currentRound = ref(1);
        const dealerIndex = ref(0);
        const dealerStreak = ref(0); // 当前庄家的连庄次数
        const history = ref([]);
        const lastDiff = ref({}); // { name: diff } for animation

        // Riichi session
        const gameMode = ref('generic');
        const roundWind = ref(0);
        const handNumber = ref(1);
        const honba = ref(0);
        const riichiSticks = ref(0);
        const riichiRule = ref({ kiriageMangan: false, kazoeYakuman: true, renchanMode: 2 });
        const initialDealerIndex = ref(0);
        const playerRiichi = ref([false, false, false, false]);

        // Riichi settle UI
        const riichiSettle = ref({
            open: false,
            winType: 'tsumo',
            winnerSeat: null,
            payerSeat: null,
            fan: 1,
            fu: 30,
            yakuman: false,
            preview: null,
            summary: '',
        });
        const ryukyokuNoten = ref([false, false, false, false]);
        
        // UI State
        const modals = ref({
            settle: false,
            seat: false,
            nextRound: false,
            history: false,
            stats: false,
            settings: false,
            dealerSet: false,
            originSet: false, // 设置原点模态框
            help: false, // 操作说明模态框
            ryukyoku: false,
            riichiSettle: false,
            matchEnd: false,
        });
        
        const matchEndRankings = ref([]);
        const matchEndSticksNote = ref('');
        
        const activeSeatIndex = ref(null);
        const newPlayerName = ref('');
        
        // Settle State
        const settleFrom = ref(null);
        const settleTo = ref(null);
        const settleAmount = ref('');
        const selectingFrom = ref(true);
        const isSelecting = ref(false); // 是否正在选择（用于高亮显示）
        const errorFrom = ref(false); // 是否显示"谁给分数"的错误提示
        const errorTo = ref(false); // 是否显示"给谁"的错误提示
        const amountInput = ref(null);

        // Drag State (for both desktop and mobile)
        const dragState = ref({
            dragging: false,
            fromIndex: null,
            overIndex: null,
            touchStartX: 0,
            touchStartY: 0,
            draggingNextRound: false // Flag for dragging next round button
        });
        let touchTimeout = null;
        let dragClone = null;
        let lastAngle = null; // Track last angle to prevent jumps
        let nextRoundTouchTimeout = null;


        // Chart
        let chartInstance = null;

        // Dice State
        const diceMode = ref(false);
        const isRolling = ref(false);
        const isAnimating = ref(false);
        const hasRolled = ref(false);
        // 两个骰子的当前旋转角度
        const diceRotation = ref([{ x: 0, y: 0 }, { x: 0, y: 0 }]);

        // Zoom State
        const globalScale = ref(1);
        const canZoomIn = ref(true);
        const canZoomOut = ref(true);
        const layoutReady = ref(false);
        const scaleAutoFit = ref(localStorage.getItem('mj_scale_auto') !== '0');
        const scaleStep = 0.10;
        const absoluteMaxScale = 4.5;
        let layoutResizeHandler = null;
        let layoutObserver = null;
        let layoutMaxScaleCache = null;

        const invalidateLayoutMaxScale = () => {
            layoutMaxScaleCache = null;
        };

        const measureLayoutMaxScale = () => {
            layoutMaxScaleCache = findMaxScaleByProbe(absoluteMaxScale);
            return layoutMaxScaleCache;
        };

        const calculateMaxScale = () => {
            if (layoutMaxScaleCache != null) return layoutMaxScaleCache;
            return measureLayoutMaxScale();
        };

        const persistScale = (scale) => {
            globalScale.value = Math.max(0.5, Math.min(absoluteMaxScale, scale));
            localStorage.setItem('mj_scale', globalScale.value.toString());
        };

        const syncScaleLimits = () => {
            const maxScale = calculateMaxScale();
            if (globalScale.value > maxScale) {
                persistScale(maxScale);
            }
            canZoomIn.value = globalScale.value < maxScale - 0.01;
            canZoomOut.value = globalScale.value > 0.5;
        };

        const applyScaleLimitsFromCache = (maxScale) => {
            if (globalScale.value > maxScale) {
                persistScale(maxScale);
            }
            canZoomIn.value = globalScale.value < maxScale - 0.01;
            canZoomOut.value = globalScale.value > 0.5;
        };

        const updateCardPositionOffsets = (scale) => {
            requestAnimationFrame(() => {
                applyCardOffsets(cardOffsetForScale(scale));
            });
        };

        const fitLayoutToScreen = () => {
            layoutReady.value = true;
            invalidateLayoutMaxScale();
            nextTick(() => {
                requestAnimationFrame(() => {
                    const maxScale = measureLayoutMaxScale();
                    const optimal = optimalScaleFromMax(maxScale);
                    persistScale(optimal);
                    applyScaleLimitsFromCache(maxScale);
                    updateCardPositionOffsets(globalScale.value);
                });
            });
        };

        const resetScaleAutoFit = () => {
            scaleAutoFit.value = true;
            localStorage.setItem('mj_scale_auto', '1');
            fitLayoutToScreen();
        };

        const toggleScaleAutoFit = () => {
            scaleAutoFit.value = !scaleAutoFit.value;
            localStorage.setItem('mj_scale_auto', scaleAutoFit.value ? '1' : '0');
            if (scaleAutoFit.value) fitLayoutToScreen();
        };

        const adjustScale = (direction) => {
            scaleAutoFit.value = false;
            localStorage.setItem('mj_scale_auto', '0');

            const proposedScale = globalScale.value + (direction * scaleStep);
            const maxScale = calculateMaxScale();

            if (direction > 0) {
                if (!canZoomIn.value) return;
                if (proposedScale >= maxScale) {
                    persistScale(maxScale);
                    canZoomIn.value = false;
                } else {
                    persistScale(proposedScale);
                    canZoomIn.value = globalScale.value < maxScale - 0.01;
                }
                canZoomOut.value = globalScale.value > 0.5;
            } else {
                if (!canZoomOut.value) return;
                if (proposedScale < 0.5) {
                    persistScale(0.5);
                    canZoomOut.value = false;
                } else {
                    persistScale(proposedScale);
                    canZoomOut.value = globalScale.value > 0.5;
                }
                canZoomIn.value = globalScale.value < maxScale - 0.01;
            }
        };

        const initLayoutScale = () => {
            layoutReady.value = true;
            invalidateLayoutMaxScale();
            requestAnimationFrame(() => {
                if (scaleAutoFit.value || !localStorage.getItem('mj_scale')) {
                    fitLayoutToScreen();
                    return;
                }
                const saved = parseFloat(localStorage.getItem('mj_scale'));
                const maxScale = measureLayoutMaxScale();
                if (!Number.isNaN(saved) && saved >= 0.5) {
                    persistScale(Math.min(saved, maxScale));
                    applyScaleLimitsFromCache(maxScale);
                } else {
                    fitLayoutToScreen();
                    return;
                }
                updateCardPositionOffsets(globalScale.value);
            });
        };

        const handleLayoutResize = debounce(() => {
            invalidateLayoutMaxScale();
            if (scaleAutoFit.value) {
                fitLayoutToScreen();
            } else {
                syncScaleLimits();
                updateCardPositionOffsets(globalScale.value);
            }
        }, 120);

        const diceStyles = computed(() => {
            return diceRotation.value.map((rot) => {
                // 如果正在动画中，使用动态生成的随机时间；否则使用复位时间
                // isAnimating 保持整个动画周期的 true，确保 easing 曲线不中断
                const transitionTime = isAnimating.value ? `${rot.duration}ms` : '0.5s';
                return {
                    transform: `rotateX(${rot.x}deg) rotateY(${rot.y}deg)`,
                    transition: `transform ${transitionTime} cubic-bezier(0.1, 0.9, 0.2, 1)`
                };
            });
        });

        const handleDialClick = () => {
            if (!diceMode.value) {
                // 进入骰子模式
                diceMode.value = true;
                hasRolled.value = false;
                resetDice(); 
            } else {
                // 已经在骰子模式
                if (isRolling.value) return; // 正在滚动交互锁定中，忽略
                // 开始掷骰子
                rollDice();
            }
        };

        const closeDiceMode = () => {
            if (isRolling.value) return; // 正在滚动交互锁定中，不可退出
            // 只要不在滚动中，点击外部都可以退出（包括没打骰子前，和打完骰子后）
            diceMode.value = false;
        };

        const resetDice = () => {
            // 随机生成初始点数
            const v1 = Math.floor(Math.random() * 6) + 1;
            const v2 = Math.floor(Math.random() * 6) + 1;
            
            const getBaseAngle = (val) => {
                switch(val) {
                    case 1: return { x: 0, y: 0 };
                    case 2: return { x: 90, y: 0 };
                    case 3: return { x: 0, y: -90 };
                    case 4: return { x: 0, y: 90 };
                    case 5: return { x: -90, y: 0 };
                    case 6: return { x: 0, y: 180 };
                    default: return { x: 0, y: 0 };
                }
            };

            const base1 = getBaseAngle(v1);
            const base2 = getBaseAngle(v2);

             diceRotation.value = [
                 { x: base1.x + Math.random() * 20 - 10, y: base1.y + Math.random() * 20 - 10 },
                 { x: base2.x + Math.random() * 20 - 10, y: base2.y + Math.random() * 20 - 10 }
             ];
        };

        const rollDice = () => {
            isRolling.value = true;     // 锁定交互，显示红光
            isAnimating.value = true;   // 开始动画 CSS
            hasRolled.value = true;
            
            const v1 = Math.floor(Math.random() * 6) + 1;
            const v2 = Math.floor(Math.random() * 6) + 1;
            
            // 基础圈数调整
            const minSpins = 4; 
            
            // 生成1000ms到2500ms之间的随机时间
            const duration1 = Math.floor(Math.random() * 1500) + 1000;
            const duration2 = Math.floor(Math.random() * 1500) + 1000;
            
            // 取最大的时间作为结束时间
            const maxDuration = Math.max(duration1, duration2);
            
            // 提前解锁交互的时间量 (ms)
            const leadTime = 800;

            diceRotation.value = [
                { ...calculateDiceRotation(0, v1, minSpins), duration: duration1 },
                { ...calculateDiceRotation(1, v2, minSpins), duration: duration2 }
            ];
            
            // 提前 leadTime 解锁交互并显示绿光（让用户感觉已经停了）
            setTimeout(() => {
                isRolling.value = false;
            }, Math.max(0, maxDuration - leadTime));

            // 动画实际结束后，重置动画状态（恢复 CSS transition 到短时间复位模式）
            setTimeout(() => {
                isAnimating.value = false;
            }, maxDuration);
        };
        
        const calculateDiceRotation = (index, value, minSpins) => {
            // 获取当前角度
            const current = diceRotation.value[index];
            
            // 目标基础角度
            let baseX = 0, baseY = 0;
            switch(value) {
                case 1: baseX = 0; baseY = 0; break;
                case 2: baseX = 90; baseY = 0; break;
                case 3: baseX = 0; baseY = -90; break;
                case 4: baseX = 0; baseY = 90; break;
                case 5: baseX = -90; baseY = 0; break;
                case 6: baseX = 0; baseY = 180; break;
            }
            
            // 计算下一个角度，确保是在当前基础上累加，且至少转 minSpins 圈
            // 1. 计算当前角度相对于360的余数，以便找到去往 baseX 的最短正向路径
            // 实际上，我们只需要确保 delta 是正的即可
            
            const calcNextAngle = (currAngle, baseAngle) => {
                // 当前角度
                const curr = currAngle;
                // 目标余数
                const targetMod = baseAngle; 
                // 当前余数
                const currMod = curr % 360;
                
                // 计算差值：我们需要加多少才能到达下一个 targetMod
                let delta = targetMod - currMod;
                
                // 确保 delta > 0，保证正向旋转
                while (delta <= 0) delta += 360;
                
                // 加上基础差值后，再额外加随机圈数
                const extraSpins = Math.floor(Math.random() * 3) + minSpins;
                
                return curr + delta + (extraSpins * 360);
            };
            
            return { 
                x: calcNextAngle(current.x, baseX),
                y: calcNextAngle(current.y, baseY)
            };
        };

        // --- Computed ---
        const activePlayers = computed(() => seats.value.filter(n => n));
        const availablePlayers = computed(() => players.value.filter(p => !seats.value.includes(p.name)));
        const seatPlayerCount = computed(() => playerCountForMode(gameMode.value));
        const isRiichi = computed(() => isRiichiMode(gameMode.value));
        const handLabel = computed(() => {
            if (!isRiichi.value) return String(currentRound.value);
            return formatHandLabel(roundWind.value, handNumber.value);
        });
        const gameModeLabel = computed(() => {
            if (gameMode.value === 'riichi-4') return '立直四麻';
            if (gameMode.value === 'sanma-3') return '三麻立直';
            return '通用';
        });
        const visibleSeatIndices = computed(() => {
            if (gameMode.value === 'sanma-3') return [0, 1, 2, 3];
            const n = seatPlayerCount.value;
            return Array.from({ length: n }, (_, i) => i);
        });

        const sanmaAbsentSeatIndex = computed(() => {
            if (gameMode.value !== 'sanma-3') return null;
            return sanmaAbsentSeat(seats.value);
        });

        const sanmaSeatedCount = computed(() =>
            seats.value.filter(Boolean).length,
        );

        const isSanmaSeatLocked = (index) =>
            gameMode.value === 'sanma-3'
            && sanmaSeatedCount.value >= 3
            && sanmaAbsentSeatIndex.value === index;

        const compassLoopCount = computed(() =>
            gameMode.value === 'sanma-3' ? 4 : seatPlayerCount.value,
        );

        const displayPosForSeat = (seatIndex) => seatIndex;

        const getSeatWind = (seatIndex) => {
            if (!seats.value[seatIndex]) return '';
            return seatWindForSeat(
                seatIndex,
                dealerIndex.value,
                seatPlayerCount.value,
                gameMode.value === 'sanma-3' ? sanmaAbsentSeatIndex.value : null,
            );
        };

        const COMPASS_NAMES = ['bottom', 'right', 'top', 'left'];
        const compassName = (compassPos) => COMPASS_NAMES[compassPos] ?? 'bottom';

        const seatIndexFromCard = (cardEl) => {
            if (!cardEl) return null;
            const raw = cardEl.dataset?.seatIndex;
            if (raw == null || raw === '') return null;
            const idx = parseInt(raw, 10);
            return Number.isNaN(idx) ? null : idx;
        };

        const applyRoundAdvance = (advance) => {
            dealerIndex.value = advance.dealerIndex;
            if (advance.dealerStreakDelta === 1) {
                dealerStreak.value++;
            } else {
                dealerStreak.value = 0;
            }
            honba.value = advance.honba;
            roundWind.value = advance.roundWind;
            handNumber.value = advance.handNumber;
            currentRound.value++;
            playerRiichi.value = [false, false, false, false];
        };

        const updateRiichiPreview = () => {
            if (!riichiSettle.value.open || riichiSettle.value.winnerSeat == null) {
                riichiSettle.value.preview = null;
                return;
            }
            if (riichiSettle.value.yakuman && riichiSettle.value.fan < 1) return;
            try {
                const absentSeat = gameMode.value === 'sanma-3' ? sanmaAbsentSeatIndex.value : null;
                if (gameMode.value === 'sanma-3' && absentSeat == null) {
                    riichiSettle.value.preview = null;
                    return;
                }
                const result = computeRiichiSettlement({
                    gameMode: gameMode.value,
                    winnerSeat: riichiSettle.value.winnerSeat,
                    payerSeat: riichiSettle.value.winType === 'ron' ? riichiSettle.value.payerSeat : null,
                    dealerIndex: dealerIndex.value,
                    fan: riichiSettle.value.yakuman ? riichiSettle.value.fan : riichiSettle.value.fan,
                    fu: riichiSettle.value.fu,
                    yakuman: riichiSettle.value.yakuman,
                    honba: honba.value,
                    riichiSticks: riichiSticks.value,
                    rule: riichiRule.value,
                    absentSeat,
                });
                riichiSettle.value.preview = result;
            } catch {
                riichiSettle.value.preview = null;
            }
        };

        watch(
            () => [
                riichiSettle.value.fan,
                riichiSettle.value.fu,
                riichiSettle.value.yakuman,
                riichiSettle.value.open,
                honba.value,
                riichiSticks.value,
                riichiRule.value.kiriageMangan,
            ],
            updateRiichiPreview,
        );
        
        // Track rotation for smooth counter-clockwise animation
        // 目标角度映射：座位0=0°, 座位1=-90°, 座位2=-180°, 座位3=-270°
        // 使用函数来延迟初始化，确保能获取到正确的初始dealerIndex
        let currentRotation = null;
        let previousDealerIndex = null;
        
        const dialRotation = computed(() => {
            if (isRiichi.value) return 0;
            const targetIndex = dealerIndex.value;
            
            // 首次初始化：直接设置到正确位置，不需要动画
            if (currentRotation === null) {
                currentRotation = -targetIndex * 90;
                previousDealerIndex = targetIndex;
                return currentRotation;
            }
            
            // 计算目标角度（东字应该指向的方向）
            // 座位0(底部)=0°, 座位1(右侧)=-90°, 座位2(顶部)=-180°, 座位3(左侧)=-270°
            const targetAngle = -targetIndex * 90;
            
            // 如果庄家变了，计算逆时针路径
            if (targetIndex !== previousDealerIndex) {
                // 计算从当前角度到目标角度的最短逆时针路径
                let diff = targetAngle - currentRotation;
                
                // 标准化差值到 (-360, 0] 区间（逆时针方向）
                while (diff > 0) diff -= 360;
                while (diff <= -360) diff += 360;
                
                // 应用逆时针旋转
                currentRotation += diff;
                previousDealerIndex = targetIndex;
            }
            
            return currentRotation;
        });
        
        // --- Methods ---
        
        watch(globalScale, (newScale) => {
            nextTick(() => updateCardPositionOffsets(newScale));
        });

        watch([gameMode, isRiichi], () => {
            invalidateLayoutMaxScale();
            nextTick(() => {
                if (scaleAutoFit.value) fitLayoutToScreen();
                else syncScaleLimits();
            });
        });
        
        // Init
        onMounted(() => {
            loadState();
            initTheme();
            initLayoutScale();
            layoutResizeHandler = handleLayoutResize;
            window.addEventListener('resize', layoutResizeHandler, { passive: true });
            window.addEventListener('orientationchange', layoutResizeHandler, { passive: true });
            const gameAreaEl = document.querySelector('.game-area');
            if (gameAreaEl && typeof ResizeObserver !== 'undefined') {
                layoutObserver = new ResizeObserver(handleLayoutResize);
                layoutObserver.observe(gameAreaEl);
            }

            requestWakeLock();
            
            // Tutorial Check
            setTimeout(() => {
                if (!localStorage.getItem('mj_tutorial_seen')) {
                    startTutorial();
                }
            }, 1000); // Delay slightly to let animations finish

            // Finish Loading
            if (window.finishLoader) {
                window.finishLoader();
            }
        });

        // Theme
        const toggleTheme = () => {
            isDark.value = !isDark.value;
            localStorage.setItem('mj_theme', isDark.value ? 'dark' : 'light');
            document.body.classList.toggle('dark', isDark.value);
        };

        // Lock Toggle
        const toggleLock = () => {
            isLocked.value = !isLocked.value;
        };

        const initTheme = () => {
            const saved = localStorage.getItem('mj_theme');
            if (saved) {
                // 如果已保存，使用保存的值
                isDark.value = saved === 'dark';
            } else {
                // 首次进入，与系统设置保持一致
                isDark.value = window.matchMedia('(prefers-color-scheme: dark)').matches;
                // 保存系统设置
                localStorage.setItem('mj_theme', isDark.value ? 'dark' : 'light');
            }
            document.body.classList.toggle('dark', isDark.value);
        };

        // Data Persistence
        const saveState = () => {
            const state = {
                players: players.value,
                seats: seats.value,
                currentRound: currentRound.value,
                dealerIndex: dealerIndex.value,
                dealerStreak: dealerStreak.value,
                history: history.value,
                gameMode: gameMode.value,
                roundWind: roundWind.value,
                handNumber: handNumber.value,
                honba: honba.value,
                riichiSticks: riichiSticks.value,
                startingScore: gameMode.value === 'sanma-3' ? 35000 : (gameMode.value === 'riichi-4' ? 25000 : 0),
                rule: riichiRule.value,
                initialDealerIndex: initialDealerIndex.value,
                playerRiichi: playerRiichi.value,
            };
            saveGameState(state);
        };

        const loadState = () => {
            const data = loadGameState();
            if (data) {
                players.value = (data.players || []).map(p => ({
                    ...p,
                    origin: p.origin || 0
                }));
                seats.value = data.seats || [null, null, null, null];
                currentRound.value = data.currentRound || 1;
                dealerIndex.value = data.dealerIndex || 0;
                dealerStreak.value = data.dealerStreak || 0;
                history.value = data.history || [];
                gameMode.value = data.gameMode || 'generic';
                roundWind.value = data.roundWind ?? 0;
                handNumber.value = data.handNumber ?? 1;
                honba.value = data.honba ?? 0;
                riichiSticks.value = data.riichiSticks ?? 0;
                riichiRule.value = data.rule || { kiriageMangan: false, kazoeYakuman: true, renchanMode: 2 };
                initialDealerIndex.value = data.initialDealerIndex ?? data.dealerIndex ?? 0;
                playerRiichi.value = data.playerRiichi || [false, false, false, false];
            }
        };

        // Player Management
        const getPlayerScore = (name) => {
            const p = players.value.find(p => p.name === name);
            if (!p) return 0;
            // 返回实际分数 = 当前分数 + 起始分数（原点）
            return p.score + (p.origin || 0);
        };
        
        // 获取玩家的当前分数（不包含原点）
        const getPlayerCurrentScore = (name) => {
            const p = players.value.find(p => p.name === name);
            return p ? p.score : 0;
        };

        const handlePlayerCardClick = (index) => {
            if (dragState.value.dragging) return;
            if (!isRiichi.value || !seats.value[index]) {
                handleSeatClick(index);
                return;
            }
            if (isLocked.value) return;
            openRiichiSettle('tsumo', index, null);
        };

        const handleSeatClick = (index) => {
            if (dragState.value.dragging) return;
            if (isSanmaSeatLocked(index)) return;
            activeSeatIndex.value = index;
            modals.value.seat = true;
        };

        const toggleRiichiStick = (seatIndex, event) => {
            event?.stopPropagation();
            if (!isRiichi.value || isLocked.value || !seats.value[seatIndex]) return;
            const name = seats.value[seatIndex];
            const p = players.value.find(pl => pl.name === name);
            if (!p) return;

            if (playerRiichi.value[seatIndex]) {
                p.score += RIICHI_DEPOSIT;
                playerRiichi.value[seatIndex] = false;
                riichiSticks.value = Math.max(0, riichiSticks.value - 1);
                history.value.unshift({
                    time: Date.now(),
                    round: currentRound.value,
                    handLabel: handLabel.value,
                    dealerIndex: dealerIndex.value,
                    type: 'riichi-undeclare',
                    seatIndex,
                    playerName: name,
                    amount: RIICHI_DEPOSIT,
                    transactions: [],
                });
            } else {
                if (getPlayerScore(name) < RIICHI_DEPOSIT) return;
                p.score -= RIICHI_DEPOSIT;
                playerRiichi.value[seatIndex] = true;
                riichiSticks.value++;
                history.value.unshift({
                    time: Date.now(),
                    round: currentRound.value,
                    handLabel: handLabel.value,
                    dealerIndex: dealerIndex.value,
                    type: 'riichi-declare',
                    seatIndex,
                    playerName: name,
                    amount: RIICHI_DEPOSIT,
                    transactions: [],
                });
            }
            saveState();
        };

        const settleRemainingRiichiSticksToDealer = () => {
            if (riichiSticks.value <= 0) return 0;
            const amount = riichiSticks.value * RIICHI_DEPOSIT;
            const dealerName = seats.value[dealerIndex.value];
            if (!dealerName) return 0;
            const p = players.value.find(pl => pl.name === dealerName);
            if (p) p.score += amount;
            const sticks = riichiSticks.value;
            riichiSticks.value = 0;
            return sticks;
        };

        const endRiichiMatch = () => {
            if (!isRiichi.value) return;
            const sticks = settleRemainingRiichiSticksToDealer();
            if (sticks > 0) {
                history.value.unshift({
                    time: Date.now(),
                    round: currentRound.value,
                    handLabel: handLabel.value,
                    type: 'match-end-sticks',
                    dealerIndex: dealerIndex.value,
                    sticks,
                    transactions: [],
                });
            }

            const loopCount = compassLoopCount.value;
            const entries = [];
            for (let i = 0; i < loopCount; i++) {
                const name = seats.value[i];
                if (!name) continue;
                entries.push({
                    name,
                    score: getPlayerScore(name),
                    wind: getSeatWind(i),
                    seatIndex: i,
                });
            }
            entries.sort((a, b) => b.score - a.score);
            matchEndRankings.value = entries.map((entry, index) => ({
                ...entry,
                rank: index + 1,
            }));
            matchEndSticksNote.value = sticks > 0
                ? `桌上 ${sticks} 根供托（${sticks * RIICHI_DEPOSIT} 点）已归当前庄家 ${seats.value[dealerIndex.value] ?? ''}。`
                : '';
            modals.value.matchEnd = true;
            saveState();
        };

        const openRiichiSettle = (winType, winnerSeat, payerSeat) => {
            const session = {
                gameMode: gameMode.value,
                roundWind: roundWind.value,
                handNumber: handNumber.value,
                honba: honba.value,
                riichiSticks: riichiSticks.value,
            };
            const { detail } = buildWinSummary(
                session,
                winnerSeat,
                dealerIndex.value,
                seats.value,
                winType === 'tsumo',
                payerSeat,
            );
            riichiSettle.value = {
                open: true,
                winType,
                winnerSeat,
                payerSeat,
                fan: 1,
                fu: 30,
                yakuman: false,
                preview: null,
                summary: detail,
            };
            modals.value.riichiSettle = true;
            nextTick(updateRiichiPreview);
        };

        const closeRiichiSettle = () => {
            modals.value.riichiSettle = false;
            riichiSettle.value.open = false;
        };

        const applyScorePreset = (preset) => {
            riichiSettle.value.fan = preset.fan;
            riichiSettle.value.fu = preset.fu;
            riichiSettle.value.yakuman = !!preset.yakuman;
            updateRiichiPreview();
        };

        const adjustRiichiFan = (delta) => {
            const rs = riichiSettle.value;
            if (delta > 0) {
                if (rs.yakuman) {
                    if (rs.fan < MAX_YAKUMAN) rs.fan += 1;
                } else if (rs.fan >= MAX_FAN) {
                    rs.yakuman = true;
                    rs.fan = 1;
                } else {
                    rs.fan += 1;
                }
            } else if (rs.yakuman) {
                if (rs.fan <= 1) {
                    rs.yakuman = false;
                    rs.fan = MAX_FAN;
                } else {
                    rs.fan -= 1;
                }
            } else {
                rs.fan = Math.max(0, rs.fan - 1);
            }
            updateRiichiPreview();
        };

        const stepRiichiFu = (delta) => {
            let idx = FU_STEPS.indexOf(riichiSettle.value.fu);
            if (idx === -1) {
                idx = FU_STEPS.findIndex((s) => s >= riichiSettle.value.fu);
                if (idx === -1) idx = FU_STEPS.length - 1;
            }
            idx = Math.max(0, Math.min(FU_STEPS.length - 1, idx + delta));
            riichiSettle.value.fu = FU_STEPS[idx];
            updateRiichiPreview();
        };

        const setRiichiFu = (fu) => {
            riichiSettle.value.fu = fu;
            updateRiichiPreview();
        };

        const riichiScoreTierLabel = computed(() => {
            const rs = riichiSettle.value;
            return formatScoreTierLabel(rs.fan, rs.fu, rs.yakuman, riichiRule.value);
        });

        const isRiichiPresetActive = (preset) =>
            isScorePresetActive(preset, riichiSettle.value);

        const confirmRiichiSettle = () => {
            const rs = riichiSettle.value;
            if (rs.winnerSeat == null) return;
            const absentSeat = gameMode.value === 'sanma-3' ? sanmaAbsentSeatIndex.value : null;
            if (gameMode.value === 'sanma-3' && absentSeat == null) {
                alert('三麻需坐满 3 人才能结算');
                return;
            }
            let result;
            try {
                result = computeRiichiSettlement({
                    gameMode: gameMode.value,
                    winnerSeat: rs.winnerSeat,
                    payerSeat: rs.winType === 'ron' ? rs.payerSeat : null,
                    dealerIndex: dealerIndex.value,
                    fan: rs.yakuman ? rs.fan : rs.fan,
                    fu: rs.fu,
                    yakuman: rs.yakuman,
                    honba: honba.value,
                    riichiSticks: riichiSticks.value,
                    rule: riichiRule.value,
                    absentSeat,
                });
            } catch (e) {
                alert(e.message || '算点失败');
                return;
            }

            const loopCount = compassLoopCount.value;
            const deltas = result.physicalDeltas;
            const diffByName = {};
            const transactions = buildPairwiseFromDeltas(deltas, seats.value, loopCount);

            for (let i = 0; i < loopCount; i++) {
                const name = seats.value[i];
                if (!name || deltas[i] === 0) continue;
                const p = players.value.find(pl => pl.name === name);
                if (p) p.score += deltas[i];
                diffByName[name] = deltas[i];
            }

            const snapshotHonba = honba.value;
            const snapshotSticks = riichiSticks.value;
            const snapshotDealer = dealerIndex.value;
            const snapshotStreak = dealerStreak.value;
            const snapshotRoundWind = roundWind.value;
            const snapshotHand = handNumber.value;

            history.value.unshift({
                time: Date.now(),
                round: currentRound.value,
                handLabel: handLabel.value,
                dealerIndex: dealerIndex.value,
                type: 'riichi-win',
                winType: rs.winType,
                winnerSeat: rs.winnerSeat,
                payerSeat: rs.payerSeat,
                fan: rs.yakuman ? undefined : rs.fan,
                fu: rs.fu,
                yakuman: rs.yakuman,
                yakumanLevel: rs.yakuman ? rs.fan : undefined,
                fenpei: [...deltas],
                transactions,
                sessionBefore: {
                    honba: snapshotHonba,
                    riichiSticks: snapshotSticks,
                    dealerIndex: snapshotDealer,
                    dealerStreak: snapshotStreak,
                    roundWind: snapshotRoundWind,
                    handNumber: snapshotHand,
                    playerRiichi: [...playerRiichi.value],
                },
            });

            lastDiff.value = diffByName;
            setTimeout(() => { lastDiff.value = {}; }, 3000);

            riichiSticks.value = 0;
            const advance = advanceAfterWin({
                gameMode: gameMode.value,
                winnerSeat: rs.winnerSeat,
                dealerIndex: dealerIndex.value,
                honba: honba.value,
                roundWind: roundWind.value,
                handNumber: handNumber.value,
                renchanMode: riichiRule.value.renchanMode ?? 2,
                absentSeat,
            });

            applyRoundAdvance(advance);
            closeRiichiSettle();
            saveState();
        };

        const buildPairwiseFromDeltas = (deltas, seatNames, loopCount) => {
            const txs = [];
            let winnerIdx = -1;
            for (let i = 0; i < loopCount; i++) {
                if ((deltas[i] ?? 0) > 0) winnerIdx = i;
            }
            if (winnerIdx < 0) return txs;
            const winnerName = seatNames[winnerIdx];
            for (let i = 0; i < loopCount; i++) {
                if (i === winnerIdx) continue;
                const loss = -(deltas[i] ?? 0);
                if (loss > 0 && seatNames[i]) {
                    txs.push({ from: seatNames[i], to: winnerName, amount: loss });
                }
            }
            return txs;
        };

        const setGameMode = (mode) => {
            if (mode === gameMode.value) return;
            const hasData = history.value.length > 0 || activePlayers.value.length > 0;
            if (hasData && !confirm('切换模式可能影响场况显示，是否继续？')) return;
            gameMode.value = mode;
            if (isRiichiMode(mode)) {
                const defaults = defaultRiichiSession(mode);
                roundWind.value = defaults.roundWind;
                handNumber.value = defaults.handNumber;
                honba.value = defaults.honba;
                riichiSticks.value = defaults.riichiSticks;
                riichiRule.value = { ...defaults.rule };
                initialDealerIndex.value = dealerIndex.value;
                playerRiichi.value = [false, false, false, false];
                players.value.forEach(p => {
                    p.origin = defaults.startingScore;
                });
            }
            saveState();
        };

        const openRyukyoku = () => {
            if (!isRiichi.value) return;
            ryukyokuNoten.value = Array.from({ length: 4 }, () => false);
            modals.value.ryukyoku = true;
        };

        const setRyukyokuTenpai = (seatIndex, tenpai) => {
            ryukyokuNoten.value[seatIndex] = !tenpai;
        };

        const setAllRyukyokuTenpai = (tenpai) => {
            const loopCount = compassLoopCount.value;
            for (let i = 0; i < loopCount; i++) {
                if (seats.value[i]) ryukyokuNoten.value[i] = !tenpai;
            }
        };

        const ryukyokuPreviewDeltas = computed(() => {
            if (!modals.value.ryukyoku) return null;
            const pc = seatPlayerCount.value;
            const absentSeat = gameMode.value === 'sanma-3' ? sanmaAbsentSeatIndex.value : null;
            return notenPenaltyDeltas(
                pc,
                dealerIndex.value,
                ryukyokuNoten.value,
                absentSeat,
            );
        });

        const ryukyokuHasPenalty = computed(() => {
            const deltas = ryukyokuPreviewDeltas.value;
            return deltas != null && deltas.some((d) => d !== 0);
        });

        const ryukyokuDealerTenpai = computed(() => !ryukyokuNoten.value[dealerIndex.value]);

        const confirmRyukyoku = () => {
            const pc = seatPlayerCount.value;
            const loopCount = compassLoopCount.value;
            const absentSeat = gameMode.value === 'sanma-3' ? sanmaAbsentSeatIndex.value : null;
            if (gameMode.value === 'sanma-3' && absentSeat == null) {
                alert('三麻需坐满 3 人才能流局');
                return;
            }
            const snapshotHonba = honba.value;
            const snapshotSticks = riichiSticks.value;
            const snapshotDealer = dealerIndex.value;
            const snapshotStreak = dealerStreak.value;
            const snapshotRoundWind = roundWind.value;
            const snapshotHand = handNumber.value;

            const deltas = notenPenaltyDeltas(
                pc,
                dealerIndex.value,
                ryukyokuNoten.value,
                absentSeat,
            );
            const diffByName = {};
            const transactions = buildPairwiseFromDeltas(deltas, seats.value, loopCount);

            for (let i = 0; i < loopCount; i++) {
                const name = seats.value[i];
                if (!name || deltas[i] === 0) continue;
                const p = players.value.find(pl => pl.name === name);
                if (p) p.score += deltas[i];
                diffByName[name] = deltas[i];
            }

            const adv = advanceAfterRyukyoku({
                gameMode: gameMode.value,
                dealerIndex: dealerIndex.value,
                roundWind: roundWind.value,
                handNumber: handNumber.value,
                honba: honba.value,
                dealerTenpai: !ryukyokuNoten.value[dealerIndex.value],
                renchanMode: riichiRule.value.renchanMode ?? 2,
                absentSeat,
            });

            history.value.unshift({
                time: Date.now(),
                round: currentRound.value,
                handLabel: handLabel.value,
                dealerIndex: dealerIndex.value,
                type: 'ryukyoku',
                noten: ryukyokuNoten.value.slice(0, loopCount),
                dealerTenpai: !ryukyokuNoten.value[dealerIndex.value],
                fenpei: deltas,
                transactions,
                sessionBefore: {
                    honba: snapshotHonba,
                    riichiSticks: snapshotSticks,
                    dealerIndex: snapshotDealer,
                    dealerStreak: snapshotStreak,
                    roundWind: snapshotRoundWind,
                    handNumber: snapshotHand,
                    playerRiichi: [...playerRiichi.value],
                },
            });

            lastDiff.value = diffByName;
            setTimeout(() => { lastDiff.value = {}; }, 3000);
            modals.value.ryukyoku = false;
            applyRoundAdvance(adv);
            saveState();
        };

        const addNewPlayer = () => {
            const name = newPlayerName.value.trim();
            if (!name) return;
            if (players.value.some(p => p.name === name)) return alert('玩家已存在');
            const origin = isRiichiMode(gameMode.value)
                ? startingScoreForMode(gameMode.value)
                : 0;
            players.value.push({ name, score: 0, origin });
            newPlayerName.value = '';
            saveState();
        };

        const sitDown = (name) => {
            seats.value[activeSeatIndex.value] = name;
            const p = players.value.find(pl => pl.name === name);
            if (p && isRiichi.value && !p.origin) {
                p.origin = startingScoreForMode(gameMode.value);
            }
            closeModal('seat');
            saveState();
        };

        // Settlement
        const openSettleModal = () => {
            if (activePlayers.value.length < 2) return alert('请先设置至少2名玩家');
            settleFrom.value = null;
            settleTo.value = null;
            settleAmount.value = '';
            selectingFrom.value = true;
            isSelecting.value = false; // 重置高亮状态
            errorFrom.value = false; // 重置错误状态
            errorTo.value = false; // 重置错误状态
            modals.value.settle = true;
        };
        
        // 点击选择框时，设置高亮状态
        const handleSelectBoxClick = (isFrom) => {
            selectingFrom.value = isFrom;
            isSelecting.value = true; // 开始选择，显示高亮
        };

        const selectSettlePlayer = (name) => {
            if (selectingFrom.value) {
                if (settleTo.value === name) settleTo.value = null; // Swap prevention
                settleFrom.value = name;
                selectingFrom.value = false; // Auto advance
            } else {
                if (settleFrom.value === name) settleFrom.value = null;
                settleTo.value = name;
                // Focus input
                nextTick(() => amountInput.value?.focus());
            }
            // 选中玩家后，移除高亮
            isSelecting.value = false;
        };

        const confirmSettle = () => {
            // 检查是否有未填写的字段
            let hasError = false;
            if (!settleFrom.value) {
                errorFrom.value = true;
                hasError = true;
            }
            if (!settleTo.value) {
                errorTo.value = true;
                hasError = true;
            }
            if (!settleAmount.value || parseInt(settleAmount.value) <= 0) {
                hasError = true;
            }
            
            // 如果有错误，闪烁一段时间后清除错误状态
            if (hasError) {
                setTimeout(() => {
                    errorFrom.value = false;
                    errorTo.value = false;
                }, 2000); // 闪烁2秒
                return;
            }
            
            const amount = parseInt(settleAmount.value);

            // Update Scores
            const fromP = players.value.find(p => p.name === settleFrom.value);
            const toP = players.value.find(p => p.name === settleTo.value);
            fromP.score -= amount;
            toP.score += amount;

            // Record History
            history.value.unshift({
                time: Date.now(),
                round: currentRound.value,
                dealerIndex: dealerIndex.value,
                type: 'manual',
                transactions: [{ from: settleFrom.value, to: settleTo.value, amount }]
            });

            // Show Diff Animation
            lastDiff.value = {};
            lastDiff.value[settleFrom.value] = -amount;
            lastDiff.value[settleTo.value] = amount;
            setTimeout(() => lastDiff.value = {}, 3000);

            saveState();
            closeModal('settle');
        };

        // Custom Keypad Logic
        const appendNumber = (num) => {
            const current = settleAmount.value === '' ? '' : String(settleAmount.value);
            // Limit length if needed, e.g. max 6 digits
            if (current.length >= 6) return; 
            settleAmount.value = current + num;
        };

        const backspaceNumber = () => {
            const current = String(settleAmount.value);
            if (current.length > 0) {
                settleAmount.value = current.slice(0, -1);
            }
        };

        // Global keyboard listener
        const handleKeydown = (e) => {
            if (!modals.value.settle) return;
            
            if (e.key >= '0' && e.key <= '9') {
                appendNumber(e.key);
            } else if (e.key === 'Backspace') {
                backspaceNumber();
            } else if (e.key === 'Enter') {
                confirmSettle();
            } else if (e.key === 'Escape') {
                closeModal('settle');
            }
        };

        onMounted(() => {
            window.addEventListener('keydown', handleKeydown);
        });

        onUnmounted(() => {
            window.removeEventListener('keydown', handleKeydown);
            if (layoutResizeHandler) {
                window.removeEventListener('resize', layoutResizeHandler);
                window.removeEventListener('orientationchange', layoutResizeHandler);
                layoutObserver?.disconnect();
                layoutObserver = null;
            }
        });

        const undo = () => {
            if (history.value.length === 0) return;
            if (!confirm('确定撤销上一次结算？')) return;

            const last = history.value.shift();
            const pc = seatPlayerCount.value;

            if (last.type === 'riichi-declare') {
                const name = last.playerName;
                const p = players.value.find(pl => pl.name === name);
                if (p) p.score += last.amount;
                playerRiichi.value[last.seatIndex] = false;
                riichiSticks.value = Math.max(0, riichiSticks.value - 1);
            } else if (last.type === 'riichi-undeclare') {
                const name = last.playerName;
                const p = players.value.find(pl => pl.name === name);
                if (p) p.score -= last.amount;
                playerRiichi.value[last.seatIndex] = true;
                riichiSticks.value++;
            } else if (last.fenpei && (last.type === 'riichi-win' || last.type === 'ryukyoku')) {
                const loopCount = compassLoopCount.value;
                for (let i = 0; i < loopCount; i++) {
                    const name = seats.value[i];
                    if (!name) continue;
                    const p = players.value.find(pl => pl.name === name);
                    if (p) p.score -= last.fenpei[i] ?? 0;
                }
                if (last.sessionBefore) {
                    honba.value = last.sessionBefore.honba;
                    riichiSticks.value = last.sessionBefore.riichiSticks;
                    dealerIndex.value = last.sessionBefore.dealerIndex;
                    dealerStreak.value = last.sessionBefore.dealerStreak;
                    roundWind.value = last.sessionBefore.roundWind;
                    handNumber.value = last.sessionBefore.handNumber;
                    if (last.sessionBefore.playerRiichi) {
                        playerRiichi.value = [...last.sessionBefore.playerRiichi];
                    }
                    currentRound.value = Math.max(1, currentRound.value - 1);
                }
            } else if (last.transactions) {
                last.transactions.forEach(t => {
                    const fromP = players.value.find(p => p.name === t.from);
                    const toP = players.value.find(p => p.name === t.to);
                    if (fromP) fromP.score += t.amount;
                    if (toP) toP.score -= t.amount;
                });
            }
            saveState();
        };

        // Next Round Button Drag (Desktop)
        const handleNextRoundDragStart = (event) => {
            dragState.value.draggingNextRound = true;
            
            const img = new Image();
            img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=';
            event.dataTransfer.setDragImage(img, 0, 0);
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', 'nextRound');
            
            dragClone = createNextRoundClone(event.clientX, event.clientY);
            
            const onDocumentDragOver = (e) => {
                e.preventDefault();
                updateDragClone(e.clientX, e.clientY);
            };
            document.addEventListener('dragover', onDocumentDragOver);
            
            const cleanup = () => {
                document.removeEventListener('dragover', onDocumentDragOver);
                document.removeEventListener('dragend', cleanup);
            };
            document.addEventListener('dragend', cleanup);
        };

        const handleNextRoundDragEnd = () => {
            const targetIndex = dragState.value.overIndex;
            
            dragState.value.draggingNextRound = false;
            dragState.value.overIndex = null;
            removeDragClone();
            
            if (targetIndex !== null) {
                // 判断是否至少有一个玩家没有入座
                const hasEmptySeat = seats.value.some(seat => seat === null);
                
                if (hasEmptySeat) {
                    // 至少有一个玩家没有入座：只指定庄家位置，不增加局数
                    dealerIndex.value = targetIndex;
                    dealerStreak.value = 0;
                    if (gameMode.value === 'sanma-3') {
                        initialDealerIndex.value = targetIndex;
                    }
                    saveState();
                } else {
                    const seat = seats.value[targetIndex];
                    if (seat) {
                        // 判断是否是同一个庄家
                        if (targetIndex === dealerIndex.value) {
                            // 连庄：增加连庄次数
                            dealerStreak.value++;
                        } else {
                            // 换庄：重置连庄次数，更换庄家
                            dealerIndex.value = targetIndex;
                            dealerStreak.value = 0;
                        }
                        currentRound.value++;
                        saveState();
                    }
                }
            }
        };

        // Next Round Button Touch (Mobile)
        const handleNextRoundTouchStart = (event) => {
            const touch = event.touches[0];
            dragState.value.touchStartX = touch.clientX;
            dragState.value.touchStartY = touch.clientY;
            
            if (nextRoundTouchTimeout) clearTimeout(nextRoundTouchTimeout);
            
            nextRoundTouchTimeout = setTimeout(() => {
                dragState.value.draggingNextRound = true;
                if (!dragClone) {
                    dragClone = createNextRoundClone(dragState.value.touchStartX, dragState.value.touchStartY);
                }
            }, 150);
        };

        const handleNextRoundTouchMove = (event) => {
            const touch = event.touches[0];
            const dx = Math.abs(touch.clientX - dragState.value.touchStartX);
            const dy = Math.abs(touch.clientY - dragState.value.touchStartY);
            
            if (dx > 10 || dy > 10) {
                if (nextRoundTouchTimeout) {
                    clearTimeout(nextRoundTouchTimeout);
                    nextRoundTouchTimeout = null;
                }
                dragState.value.draggingNextRound = true;
                
                if (!dragClone) {
                    dragClone = createNextRoundClone(touch.clientX, touch.clientY);
                }
            }
            
            if (!dragState.value.draggingNextRound) return;
            
            // Don't preventDefault here - it may be too late and cause warnings
            updateDragClone(touch.clientX, touch.clientY);
            
            // Find which card is under touch
            const element = document.elementFromPoint(touch.clientX, touch.clientY);
            const card = element?.closest('.player-card');
            
            if (card) {
                const allCards = document.querySelectorAll('.player-card');
                const cardIndex = Array.from(allCards).indexOf(card);
                
                if (cardIndex !== -1) {
                    const seat = seats.value[cardIndex];
                    const hasEmptySeat = seats.value.some(s => s === null);
                    if (hasEmptySeat || seat) {
                        dragState.value.overIndex = cardIndex;
                    } else {
                        dragState.value.overIndex = null;
                    }
                }
            } else {
                dragState.value.overIndex = null;
            }
        };

        const handleNextRoundTouchEnd = (event) => {
            if (nextRoundTouchTimeout) {
                clearTimeout(nextRoundTouchTimeout);
                nextRoundTouchTimeout = null;
            }
            
            const wasDragging = dragState.value.draggingNextRound;
            const targetIndex = dragState.value.overIndex;
            
            if (wasDragging && targetIndex !== null) {
                // Don't preventDefault here - it may be too late and cause warnings
                
                // 判断是否至少有一个玩家没有入座
                const hasEmptySeat = seats.value.some(seat => seat === null);
                
                if (hasEmptySeat) {
                    // 至少有一个玩家没有入座：只指定庄家位置，不增加局数
                    dealerIndex.value = targetIndex;
                    dealerStreak.value = 0;
                    if (gameMode.value === 'sanma-3') {
                        initialDealerIndex.value = targetIndex;
                    }
                    saveState();
                } else {
                    const seat = seats.value[targetIndex];
                    if (seat) {
                        // 判断是否是同一个庄家
                        if (targetIndex === dealerIndex.value) {
                            // 连庄：增加连庄次数
                            dealerStreak.value++;
                        } else {
                            // 换庄：重置连庄次数，更换庄家
                            dealerIndex.value = targetIndex;
                            dealerStreak.value = 0;
                        }
                        currentRound.value++;
                        saveState();
                    }
                }
            }
            
            dragState.value.draggingNextRound = false;
            dragState.value.overIndex = null;
            removeDragClone();
        };

        // Drag Clone Helpers
        const getCardOffset = () => {
            return { x: 80, y: 40 };
        };

        const normalizeAngle = (angle) => {
            // Normalize angle to 0-360 range
            while (angle < 0) angle += 360;
            while (angle >= 360) angle -= 360;
            return angle;
        };
        
        const calculateRotationAngle = (x, y) => {
            // Calculate screen center
            const centerX = window.innerWidth / 2;
            const centerY = window.innerHeight / 2;
            
            // Calculate angle from center to cursor position
            // atan2 returns angle in radians, convert to degrees
            // Add 90 to adjust because our cards point "up" at 0 degrees
            // Add 180 to make it point outward (away from center)
            let angle = Math.atan2(y - centerY, x - centerX) * (180 / Math.PI) + 90 + 180;
            
            // Smooth angle transition to prevent jumps
            if (lastAngle !== null) {
                // Normalize the difference to find shortest path
                let diff = angle - lastAngle;
                
                // Wrap difference to [-180, 180] range
                while (diff > 180) diff -= 360;
                while (diff < -180) diff += 360;
                
                // Apply the shortest path difference
                angle = lastAngle + diff;
            }
            
            lastAngle = angle;
            return angle;
        };
        
        const createDragClone = (seatName, x, y, positionIndex) => {
            // Reset angle tracking for new drag
            lastAngle = null;
            
            const clone = document.createElement('div');
            clone.className = 'drag-clone';
            clone.innerHTML = `
                <div class="player-name">${seatName}</div>
                <div class="player-score">${getPlayerScore(seatName)}</div>
            `;
            const offset = getCardOffset();
            clone.style.left = `${x - offset.x}px`;
            clone.style.top = `${y - offset.y}px`;
            
            // Calculate rotation based on position relative to screen center
            const angle = calculateRotationAngle(x, y);
            clone.style.transform = `rotate(${angle}deg)`;
            
            document.body.appendChild(clone);
            
            // Trigger fade in
            requestAnimationFrame(() => {
                clone.classList.add('show');
            });
            
            return clone;
        };

        const updateDragClone = (x, y) => {
            if (dragClone) {
                const offset = getCardOffset();
                dragClone.style.left = `${x - offset.x}px`;
                dragClone.style.top = `${y - offset.y}px`;
                
                // Update rotation based on new position relative to screen center
                const angle = calculateRotationAngle(x, y);
                dragClone.style.transform = `rotate(${angle}deg)`;
            }
        };

        const removeDragClone = () => {
            if (dragClone) {
                dragClone.classList.remove('show');
                setTimeout(() => {
                    if (dragClone && dragClone.parentNode) {
                        dragClone.parentNode.removeChild(dragClone);
                    }
                    dragClone = null;
                    lastAngle = null; // Reset angle tracking
                }, 200); // Match transition duration
            }
        };

        const createNextRoundClone = (x, y) => {
            lastAngle = null;
            
            const clone = document.createElement('div');
            clone.className = 'drag-clone next-round-clone';
            clone.innerHTML = `
                <div class="clone-text">
                    <i class="fas fa-crown" style="font-size: 24px; margin-bottom: 8px;"></i>
                    <div>指定庄家</div>
                </div>
            `;
            const offset = getCardOffset();
            clone.style.left = `${x - offset.x}px`;
            clone.style.top = `${y - offset.y}px`;
            
            const angle = calculateRotationAngle(x, y);
            clone.style.transform = `rotate(${angle}deg)`;
            
            document.body.appendChild(clone);
            
            requestAnimationFrame(() => {
                clone.classList.add('show');
            });
            
            return clone;
        };

        // Drag and Drop (Desktop)
        const handleDragStart = (index, event) => {
            const seat = seats.value[index];
            if (!seat) return;
            
            dragState.value.dragging = true;
            dragState.value.fromIndex = index;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', index.toString());
            
            // Hide default drag image
            const img = new Image();
            img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=';
            event.dataTransfer.setDragImage(img, 0, 0);
            
            // Create clone at cursor position with proper rotation
            dragClone = createDragClone(seat, event.clientX, event.clientY, index);
            
            // Add document-level dragover listener to track cursor position everywhere with high frequency
            const onDocumentDragOver = (e) => {
                e.preventDefault(); // Allow drop and ensure continuous events
                updateDragClone(e.clientX, e.clientY);
            };
            document.addEventListener('dragover', onDocumentDragOver);
            
            const cleanup = () => {
                document.removeEventListener('dragover', onDocumentDragOver);
                document.removeEventListener('dragend', cleanup);
            };
            document.addEventListener('dragend', cleanup);
        };

        const handleDragEnd = () => {
            dragState.value.dragging = false;
            dragState.value.fromIndex = null;
            dragState.value.overIndex = null;
            removeDragClone();
        };

        const handleDragOver = (index, event) => {
            event.preventDefault();
            
            // Update clone position
            updateDragClone(event.clientX, event.clientY);
            
            const seat = seats.value[index];
            
            // Accept both player card drag and next round button drag
            if (dragState.value.draggingNextRound) {
                // For next round drag, check if at least one empty seat (allow any position) or if seat is occupied
                const hasEmptySeat = seats.value.some(s => s === null);
                if (hasEmptySeat || seat) {
                    dragState.value.overIndex = index;
                    event.dataTransfer.dropEffect = 'move';
                } else {
                    dragState.value.overIndex = null;
                }
            } else {
                // For player card drag, can't drag to self or empty seat
                if (!seat || index === dragState.value.fromIndex) {
                    dragState.value.overIndex = null;
                    return;
                }
                dragState.value.overIndex = index;
                event.dataTransfer.dropEffect = 'move';
            }
        };

        const handleDragLeave = () => {
            dragState.value.overIndex = null;
        };

        const handleDrop = (toIndex, event) => {
            event.preventDefault();

            // Fix: If dragging "Next Round" button, do not process here and do not clear state.
            // The logic is handled in handleNextRoundDragEnd using the overIndex state.
            if (dragState.value.draggingNextRound) {
                return;
            }

            const fromIndex = parseInt(event.dataTransfer.getData('text/plain'));
            
            const fromSeat = seats.value[fromIndex];
            const toSeat = seats.value[toIndex];
            
            if (!fromSeat || !toSeat || fromIndex === toIndex) {
                handleDragEnd();
                return;
            }

            // Open quick settle modal
            openQuickSettle(fromSeat, toSeat);
            handleDragEnd();
        };

        // Touch Events (Mobile)
        const handleTouchStart = (index, event) => {
            const seat = seats.value[index];
            if (!seat) return;
            
            const touch = event.touches[0];
            dragState.value.touchStartX = touch.clientX;
            dragState.value.touchStartY = touch.clientY;
            dragState.value.fromIndex = index;
            
            // Clear any existing timeout
            if (touchTimeout) clearTimeout(touchTimeout);
            
            // Delay to distinguish between tap and drag
            touchTimeout = setTimeout(() => {
                // Check if finger hasn't moved much (still holding)
                dragState.value.dragging = true;
                // Create clone for touch drag with proper rotation
                if (!dragClone) {
                    dragClone = createDragClone(seat, dragState.value.touchStartX, dragState.value.touchStartY, index);
                }
            }, 150);
        };

        const handleTouchMove = (event) => {
            const touch = event.touches[0];
            const dx = Math.abs(touch.clientX - dragState.value.touchStartX);
            const dy = Math.abs(touch.clientY - dragState.value.touchStartY);
            
            // If moved more than 10px, consider it a drag
            if (dx > 10 || dy > 10) {
                if (touchTimeout) {
                    clearTimeout(touchTimeout);
                    touchTimeout = null;
                }
                dragState.value.dragging = true;
                
                // Create clone if not already created with proper rotation
                if (!dragClone) {
                    const seat = seats.value[dragState.value.fromIndex];
                    if (seat) {
                        dragClone = createDragClone(seat, touch.clientX, touch.clientY, dragState.value.fromIndex);
                    }
                }
            }
            
            if (!dragState.value.dragging) return;
            
            event.preventDefault();
            
            // Update clone position
            updateDragClone(touch.clientX, touch.clientY);
            
            // Find which card is under the touch point
            const element = document.elementFromPoint(touch.clientX, touch.clientY);
            const card = element?.closest('.player-card[data-seat-index]');
            
            if (card) {
                const cardIndex = seatIndexFromCard(card);
                
                if (cardIndex != null && cardIndex !== dragState.value.fromIndex) {
                    const seat = seats.value[cardIndex];
                    if (seat) {
                        dragState.value.overIndex = cardIndex;
                    } else {
                        dragState.value.overIndex = null;
                    }
                }
            } else {
                dragState.value.overIndex = null;
            }
        };

        const handleTouchEnd = (event) => {
            // Clear timeout if it hasn't fired yet
            if (touchTimeout) {
                clearTimeout(touchTimeout);
                touchTimeout = null;
            }
            
            const wasDragging = dragState.value.dragging;
            const fromIndex = dragState.value.fromIndex;
            const toIndex = dragState.value.overIndex;
            
            // If was actually dragging and dropped on a valid target
            if (wasDragging && toIndex !== null && fromIndex !== toIndex) {
                event.preventDefault(); // Prevent click event
                
                const fromSeat = seats.value[fromIndex];
                const toSeat = seats.value[toIndex];
                
                // Reset drag state (will remove clone)
                handleDragEnd();
                
                if (fromSeat && toSeat) {
                    openQuickSettle(fromSeat, toSeat);
                }
            } else {
                const tapIndex = fromIndex;
                handleDragEnd();
                if (tapIndex != null && seats.value[tapIndex] && isRiichi.value && !isLocked.value) {
                    openRiichiSettle('tsumo', tapIndex, null);
                }
            }
        };

        // Quick Settle Modal
        const openQuickSettle = (from, to) => {
            if (isRiichi.value) {
                const fromIndex = seats.value.indexOf(from);
                const toIndex = seats.value.indexOf(to);
                if (fromIndex >= 0 && toIndex >= 0) {
                    openRiichiSettle('ron', toIndex, fromIndex);
                }
                return;
            }
            settleFrom.value = from;
            settleTo.value = to;
            settleAmount.value = '';
            selectingFrom.value = false; // Neither is selecting, we are ready to input
            isSelecting.value = false; // 通过拖拽打开时，不需要高亮
            errorFrom.value = false; // 重置错误状态
            errorTo.value = false; // 重置错误状态
            modals.value.settle = true;
        };


        // Round Management
        const handleNextRoundClick = () => {
            // Don't trigger click if we just finished dragging
            if (dragState.value.draggingNextRound) return;
            
            // Check if settled this round
            const settled = history.value.some(h => h.round === currentRound.value);
            if (!settled && !confirm('本局尚未结算，确定进入下一局？')) return;
            
            // 直接换庄到下一家
            const pc = seatPlayerCount.value;
            dealerIndex.value = (dealerIndex.value + 1) % pc;
            dealerStreak.value = 0;
            if (isRiichi.value) {
                let hn = handNumber.value + 1;
                let rw = roundWind.value;
                if (hn > 4) {
                    hn = 1;
                    rw = (rw + 1) % 4;
                }
                handNumber.value = hn;
                roundWind.value = rw;
                honba.value = 0;
            }
            currentRound.value++;
            saveState();
        };
        
        const nextRoundCheck = () => {
            // 已废弃，保留兼容
        };

        const nextRound = (changeDealer) => {
            // 已废弃，保留兼容
        };

        // Settings & Utils
        const closeModal = (name) => modals.value[name] = false;
        const formatTime = (ts) => new Date(ts).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second: '2-digit'});
        
        const clearData = () => {
            if (confirm('确定清空所有数据？')) {
                clearGameStorage();
                localStorage.removeItem('mj_scale');
                localStorage.removeItem('mj_scale_auto');
                location.reload();
            }
        };
        
        // 设置原点
        const showOriginSet = () => {
            modals.value.originSet = true;
        };
        
        const updateOrigin = (name, value) => {
            const p = players.value.find(p => p.name === name);
            if (p) {
                const numValue = parseInt(value) || 0;
                p.origin = numValue;
                saveState();
            }
        };
        
        const setOriginToZero = (name) => {
            const p = players.value.find(p => p.name === name);
            if (p) {
                p.origin = 0;
                saveState();
            }
        };

        const standUp = () => {
            seats.value[activeSeatIndex.value] = null;
            closeModal('seat');
            saveState();
        };

        // Tutorial State
        const tutorialState = ref({
            active: false,
            step: 0,
            showReplay: false
        });

        const tutorialSteps = [
            {
                target: '.player-card.empty-seat', // 1
                fallbackTarget: '.player-card',
                message: '点击任意座位添加玩家（支持超过四名玩家计分）',
                position: 'bottom'
            },
            {
                target: '.next-round-btn', // 2
                message: '所有座位都入座前，拖动"下一局"到座位可指定初始庄家',
                position: 'top'
            },
            {
                target: '.player-card:not(.empty-seat)', // 3 (will fallback if no player seated)
                fallbackTarget: '.player-card', 
                message: '点击已入座玩家可更换或下座',
                position: 'bottom'
            },
            {
                target: '.center-dial', // 4
                message: '中间显示当前圈风（东南西北）和局数，点击可以打骰子',
                position: 'bottom'
            },
            {
                target: '.next-round-btn', // 5
                message: '点击直接轮庄给下家；拖动到座位可指定下一局庄家',
                position: 'top'
            },
            {
                target: '.dealer-badge', // Extra: Dealer info
                message: '庄家右上角显示连庄次数',
                position: 'bottom' 
            },
            {
                target: '.header', // 6
                message: '顶部栏：缩放、图表、历史、锁屏、教程、设置',
                position: 'bottom'
            }
        ];
        
        const currentTutorialStep = computed(() => {
            if (!tutorialState.value.active) return null;
            return tutorialSteps[tutorialState.value.step];
        });

        const startTutorial = () => {
            modals.value.settings = false; // Close settings modal if open
            tutorialState.value.active = true;
            tutorialState.value.step = 0;
        };

        const nextTutorial = () => {
            if (tutorialState.value.step < tutorialSteps.length - 1) {
                tutorialState.value.step++;
            } else {
                endTutorial();
            }
        };

        const prevTutorial = () => {
            if (tutorialState.value.step > 0) {
                tutorialState.value.step--;
            }
        };

        const endTutorial = () => {
            tutorialState.value.active = false;
            localStorage.setItem('mj_tutorial_seen', 'true');
        };

        // Tutorial Spotlight Logic
        const spotlightStyle = ref({});
        const messageStyle = ref({});

        const updateTutorialSpotlight = () => {
            if (!tutorialState.value.active) return;
            
            const step = tutorialSteps[tutorialState.value.step];
            if (!step) return;

            nextTick(() => {
                let target = document.querySelector(step.target);
                if (!target && step.fallbackTarget) {
                    target = document.querySelector(step.fallbackTarget);
                }

                if (target) {
                    const rect = target.getBoundingClientRect();
                    const padding = 10;
                    
                    // Spotlight box around target
                    spotlightStyle.value = {
                        top: `${rect.top - padding}px`,
                        left: `${rect.left - padding}px`,
                        width: `${rect.width + padding * 2}px`,
                        height: `${rect.height + padding * 2}px`,
                        opacity: 1
                    };

                    // Message box position
                    const msgRect = { width: 280, height: 100 }; // Est
                    let msgTop = 0;
                    let msgLeft = rect.left + rect.width / 2 - 140; // Center horizontally

                    // Clamp horizontal
                    if (msgLeft < 20) msgLeft = 20;
                    if (msgLeft + 280 > window.innerWidth - 20) msgLeft = window.innerWidth - 300;

                    // Vertical Auto-Positioning
                    // Default based on step config
                    let preferTop = step.position === 'top';
                    
                    // If preference is bottom, check if there's enough space below
                    // Message box height approx 150px with buttons
                    const msgHeight = 150; 
                    const spaceBelow = window.innerHeight - (rect.bottom + padding + 20);
                    const spaceAbove = rect.top - padding - 20;

                    if (!preferTop && spaceBelow < msgHeight) {
                        // Not enough space below, try top
                        if (spaceAbove > msgHeight) {
                            preferTop = true;
                        }
                    } else if (preferTop && spaceAbove < msgHeight) {
                        // Not enough space above, try bottom
                        if (spaceBelow > msgHeight) {
                            preferTop = false;
                        }
                    }

                    if (preferTop) {
                        msgTop = rect.top - padding - 20; // Position immediately above spotlight
                        // Adjust translate to move it up by 100% of its own height
                        // Since we don't know exact height, we can use style transform or just enough px
                        // Better: use transform: translateY(-100%) in CSS if we position at top edge
                        // Or here calculate an offset. 
                        // Let's use CSS transform approach for dynamic height:
                        // If top-aligned, we set top to rect.top - padding - 10
                        // And use transform: translateY(-100%)
                        
                        // Current logic:
                        // msgTop = rect.top - padding - 120; // Hardcoded 120 height
                        
                        // Improved logic:
                        msgTop = rect.top - padding - 16;
                        messageStyle.value = {
                            top: `${msgTop}px`,
                            left: `${msgLeft}px`,
                            opacity: 1,
                            transform: 'translateY(-100%)' // Shift up by full height
                        };
                    } else {
                        msgTop = rect.bottom + padding + 16; // Below
                        messageStyle.value = {
                            top: `${msgTop}px`,
                            left: `${msgLeft}px`,
                            opacity: 1,
                            transform: 'none'
                        };
                    }
                } else {
                    // Fallback if target not found (e.g. Center screen)
                    spotlightStyle.value = { opacity: 0 };
                    messageStyle.value = { 
                        top: '50%', 
                        left: '50%', 
                        transform: 'translate(-50%, -50%)',
                        opacity: 1 
                    };
                }
            });
        };

        watch(() => [tutorialState.value.step, tutorialState.value.active], () => {
             updateTutorialSpotlight();
        });
        
        // Also update on resize
        onMounted(() => {
            window.addEventListener('resize', updateTutorialSpotlight);
        });

        // Chart
        const showStats = () => {
            modals.value.stats = true;
            nextTick(renderChart);
        };

        const renderChart = () => {
            const ctx = document.getElementById('scoreChart').getContext('2d');
            if (chartInstance) chartInstance.destroy();

            // Prepare Data
            const allNames = players.value.map(p => p.name);
            
            // 1. 初始状态 (Round 0) - 包含原点
            const roundSnapshots = new Map(); // round -> scores object
            // 初始分数应该是每个玩家的原点值
            const initialScores = Object.fromEntries(allNames.map(n => {
                const p = players.value.find(p => p.name === n);
                return [n, p ? (p.origin || 0) : 0];
            }));
            roundSnapshots.set(0, initialScores);
            
            // 2. Replay history to build snapshots
            // 先按时间排序
            const sortedHistory = [...history.value].sort((a, b) => a.time - b.time);
            
            // 临时记录当前分数（从原点开始）
            let currentScores = { ...initialScores };
            
            // 遍历每一条记录，更新当前分数，并更新对应局数的快照
            // 注意：如果同一局有多条记录，后面的会覆盖前面的快照，这是正确的，因为我们要的是"该局结束时的状态"
            sortedHistory.forEach(h => {
                h.transactions.forEach(t => {
                    if (currentScores[t.from] !== undefined) currentScores[t.from] -= t.amount;
                    if (currentScores[t.to] !== undefined) currentScores[t.to] += t.amount;
                });
                // 更新该局的快照（深拷贝）
                roundSnapshots.set(h.round, { ...currentScores });
            });

            // 3. 转换为数组并按局数排序
            // 注意：可能存在跳局的情况（比如撤销后），或者中间某局没有记录。
            // Chart.js 需要连续的 labels 吗？最好是连续的。
            // 我们获取最大的 round
            const maxRound = Math.max(...roundSnapshots.keys());
            const labels = [];
            const dataPoints = [];

            // 填充每一局的数据
            // 如果某局没有记录，就沿用上一局的数据
            let lastScores = roundSnapshots.get(0);
            
            for (let r = 0; r <= maxRound; r++) {
                labels.push(r === 0 ? '开始' : `R${r}`);
                
                if (roundSnapshots.has(r)) {
                    lastScores = roundSnapshots.get(r);
                }
                // 如果这一局没有记录（比如直接跳到了下一局，或者还没打完），沿用上一局
                // 但这里我们只展示"有记录"的局数？
                // 不，通常展示连续的局数比较直观。
                dataPoints.push(lastScores);
            }

            const datasets = allNames.map((name, i) => {
                const colors = ['#6366f1', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6'];
                return {
                    label: name,
                    data: dataPoints.map(scores => scores[name] || 0),
                    borderColor: colors[i % colors.length],
                    tension: 0.3,
                    fill: false
                };
            });

            chartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                    labels,
                    datasets
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { 
                            labels: { 
                                color: isDark.value ? '#f9fafb' : '#1f2937',
                                usePointStyle: true,
                                pointStyle: 'rect',
                                padding: 12,
                                font: {
                                    size: 13
                                },
                                boxWidth: 12
                            },
                            // 对于4个玩家，设置maxWidth为240-260之间的值应该能实现2x2布局
                            align: 'center',
                            maxWidth: allNames.length === 4 ? 250 : (allNames.length <= 3 ? 500 : 800)
                        }
                    },
                    scales: {
                        x: { ticks: { color: isDark.value ? '#9ca3af' : '#6b7280' }, grid: { color: isDark.value ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' } },
                        y: {
                            ticks: {
                                color: isDark.value ? '#9ca3af' : '#6b7280',
                                // 只显示整数，不显示小数
                                callback: function(value) {
                                    if (Math.floor(value) === value) {
                                        return value;
                                    }
                                }
                            }, 
                            grid: { color: isDark.value ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }
                        }
                    }
                }
            });
        };

        // Wake Lock
        const requestWakeLock = async () => {
            try {
                if ('wakeLock' in navigator) {
                    await navigator.wakeLock.request('screen');
                }
            } catch (e) { console.log(e); }
        };
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') requestWakeLock();
        });

        return {
            isDark, toggleTheme,
            isLocked, toggleLock,
            seats, players, currentRound, dealerIndex, dealerStreak, history, lastDiff,
            gameMode, gameModeLabel, isRiichi, handLabel, honba, riichiSticks, riichiRule,
            visibleSeatIndices, seatPlayerCount, playerRiichi,
            sanmaAbsentSeatIndex, sanmaSeatedCount, isSanmaSeatLocked, compassLoopCount,
            displayPosForSeat, getSeatWind, compassName,
            modals, closeModal,
            activePlayers, availablePlayers, dialRotation,
            getPlayerScore, getPlayerCurrentScore, handleSeatClick, handlePlayerCardClick,
            addNewPlayer, sitDown, newPlayerName,
            openSettleModal, settleFrom, settleTo, settleAmount, selectingFrom, isSelecting, errorFrom, errorTo, selectSettlePlayer, confirmSettle, amountInput, handleSelectBoxClick,
            appendNumber, backspaceNumber,
            undo, handleNextRoundClick, nextRoundCheck, nextRound,
            formatTime, clearData, setGameMode,
            openRyukyoku, setRyukyokuTenpai, setAllRyukyokuTenpai, confirmRyukyoku,
            ryukyokuNoten, ryukyokuDealerTenpai, ryukyokuPreviewDeltas, ryukyokuHasPenalty,
            toggleRiichiStick, endRiichiMatch, RIICHI_DEPOSIT,
            matchEndRankings, matchEndSticksNote,
            riichiSettle, SCORE_PRESETS, FU_HINTS, formatYakumanLabel,
            applyScorePreset, adjustRiichiFan, stepRiichiFu, setRiichiFu,
            riichiScoreTierLabel, isRiichiPresetActive,
            confirmRiichiSettle, closeRiichiSettle, updateRiichiPreview,
            showStats, showHistory: () => modals.value.history = true, showSettings: () => modals.value.settings = true, showRoundModal: () => {},
            showHelp: () => modals.value.help = true,
            showOriginSet, updateOrigin, setOriginToZero, standUp,
            // Zoom
            adjustScale, resetScaleAutoFit, toggleScaleAutoFit, globalScale, canZoomIn, canZoomOut, layoutReady, scaleAutoFit,
            // Drag and Drop (Player Cards)
            dragState,
            handleDragStart, handleDragEnd, handleDragOver, handleDragLeave, handleDrop,
            handleTouchStart, handleTouchMove, handleTouchEnd,
            // Drag and Drop (Next Round Button)
            handleNextRoundDragStart, handleNextRoundDragEnd,
            handleNextRoundTouchStart, handleNextRoundTouchMove, handleNextRoundTouchEnd,
            
            // Dice
            diceMode, isRolling, hasRolled, diceStyles, handleDialClick, closeDiceMode,

            // Tutorial
            tutorialState, currentTutorialStep, startTutorial, nextTutorial, prevTutorial, endTutorial, spotlightStyle, messageStyle
        };
    }
}).mount('#app');

