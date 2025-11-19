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

            const duration = 1000;
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
            help: false // 操作说明模态框
        });
        
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
        const scaleStep = 0.10; // 每次调整百分之多少
        const absoluteMaxScale = 3.5; // 绝对最大缩放限制（原2.5提升40%）

        const adjustScale = (direction) => {
            // Calculate potential new scale
            const proposedScale = globalScale.value + (direction * scaleStep);
            
            // Calculate Max Possible Scale based on current DOM state
            const maxScale = calculateMaxScale();
            
            if (direction > 0) {
                // Zoom In
                if (!canZoomIn.value) return;
                
                if (proposedScale >= maxScale) {
                    // If proposed step exceeds max, clamp to max and disable zoom in
                    globalScale.value = maxScale;
                    canZoomIn.value = false;
                } else {
                    globalScale.value = proposedScale;
                    // Re-check if we can still zoom in
                    canZoomIn.value = globalScale.value < maxScale - 0.01; // Add epsilon
                }
                // Always allow zoom out after zooming in (unless at minimum)
                canZoomOut.value = globalScale.value > 0.5;
            } else {
                // Zoom Out
                if (!canZoomOut.value) return;
                
                if (proposedScale < 0.5) {
                    globalScale.value = 0.5;
                    canZoomOut.value = false;
                    // Always allow zoom in after reaching minimum
                    canZoomIn.value = globalScale.value < maxScale;
                    // 保存缩放值到 localStorage
                    localStorage.setItem('mj_scale', globalScale.value.toString());
                    return;
                }
                
                globalScale.value = proposedScale;
                // Always allow zoom in after zooming out
                canZoomIn.value = globalScale.value < maxScale;
                canZoomOut.value = globalScale.value > 0.5;
            }
            
            // 保存缩放值到 localStorage
            localStorage.setItem('mj_scale', globalScale.value.toString());
        };
        
        // Calculate the maximum scale allowed before collision or overflow
        const calculateMaxScale = () => {
            const card0 = document.querySelector('.pos-0');
            const dial = document.querySelector('.center-dial');
            
            if (!card0 || !dial) return absoluteMaxScale; // Fallback max if DOM not ready
            
            // 获取元素尺寸
            // 注意：我们需要原始（未缩放）的尺寸。
            // getBoundingClientRect 获取的是变换后的尺寸。
            // offsetHeight/offsetWidth 通常也是包含变换的（取决于浏览器，但在 Vue scale binding 下通常是）。
            // 为了准确，我们除以当前的 globalScale (如果它是通过 CSS transform scale 应用的)
            // 或者，我们可以临时创建一个不可见的克隆来测量，但这太重了。
            // 既然我们知道 scale 是通过 var(--scale-factor) 应用的 transform，
            // 我们尝试获取元素的 offsetHeight，然后除以当前的 globalScale.value 来还原原始尺寸。
            // 但要注意 offsetHeight 返回的是整数。
            
            // 更可靠的方法：直接读取 CSS 变量可能不准，我们假设当前的 offsetHeight 是应用了 scale 后的。
            // 但实际上 transform: scale() 不会改变 offsetHeight/Width 的返回值 (Layout size vs Render size).
            // 在大多数浏览器中，transform 不改变 offsetWidth/Height 属性值，它们返回的是 layout 尺寸。
            // 只有 getBoundingClientRect 会返回 render 尺寸。
            // 所以直接用 offsetHeight 应该是原始尺寸。为了保险，我们做个校验。
            
            const currentScale = globalScale.value;
            const rect = card0.getBoundingClientRect();
            
            // 如果 rect.height 明显大于 offsetHeight，说明 offsetHeight 是原始尺寸。
            // 如果它们接近，说明 offsetHeight 已经是缩放后的（不太可能）。
            // 这里的 H 应该是原始高度。
            let H = card0.offsetHeight;
            
            // 如果 offsetHeight 不准确，我们可以用 rect.height / currentScale
            if (Math.abs(rect.height - H * currentScale) < 5) {
                 // 这是一个验证，如果成立，说明 offsetHeight 确实是原始高度
            } else if (Math.abs(rect.height - H) < 5 && currentScale !== 1) {
                 // 如果 rect.height 等于 offsetHeight 且 scale != 1，说明 offsetHeight 也是缩放后的？
                 // 或者 transform 没生效？
                 // 通常 transform 不影响 offsetHeight。我们暂且信任 offsetHeight。
            }

            // Use offsetWidth for dial diameter (assuming square/circle)
            const dialRadius = dial.offsetWidth / 2;
            
            // 屏幕尺寸
            const screenW = window.innerWidth;
            const screenH = window.innerHeight;
            const spaceX = screenW / 2;
            const spaceY = screenH / 2;
            
            // 边距与间隙
            // CSS 中定义的边距是 20px (bottom/right/top/left)
            // 我们希望保留至少 5px 的间隙防止重叠
            const margin = 20;
            const gap = 5;
            
            // 公式推导：
            // 由于我们有 offset 补偿逻辑 (updateCardPositionOffsets)，
            // 卡片的视觉外边缘始终保持在距离屏幕边缘 margin (20px) 的位置。
            // 因此，卡片中心距离屏幕中心的距离是：
            // CenterPos = Space - (margin + VisualCardHeight / 2)
            // 其中 VisualCardHeight = H * s
            // CenterPos = Space - 20 - H * s / 2
            //
            // 碰撞检测：
            // 卡片视觉内边缘不能碰到转盘。
            // 卡片内边缘位置 = CenterPos - VisualCardHeight / 2
            //               = Space - 20 - H * s / 2 - H * s / 2
            //               = Space - 20 - H * s
            // 转盘边缘位置 = DialRadius * s
            //
            // 条件：卡片内边缘 > 转盘边缘 + gap
            // Space - 20 - H * s >= DialRadius * s + gap
            // Space - 20 - gap >= s * (H + DialRadius)
            // s <= (Space - 25) / (H + DialRadius)
            
            const limitX = (spaceX - margin - gap) / (H + dialRadius);
            const limitY = (spaceY - margin - gap) / (H + dialRadius);
            
            // 取两者较小值
            const calculatedMax = Math.min(limitX, limitY);
            
            // 确保不为负数（极小屏幕情况）
            const safeMax = Math.max(0.5, calculatedMax);
            
            return Math.min(safeMax, absoluteMaxScale);
        };
        
        // Calculate optimal scale based on screen size and card dimensions
        const calculateOptimalScale = () => {
            const maxScale = calculateMaxScale();
            // 直接使用计算出的最大安全值，或者稍微留一点点余地 (98%)
            // 既然用户要求"最大"，我们可以直接用 maxScale，或者留极小的 buffer
            return Math.min(maxScale * 0.98, absoluteMaxScale);
        };

        // Legacy check function replaced by direct calculation
        const checkCollision = (scale) => {
            return scale > calculateMaxScale();
        };

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
        
        // Track rotation for smooth counter-clockwise animation
        // 目标角度映射：座位0=0°, 座位1=-90°, 座位2=-180°, 座位3=-270°
        // 使用函数来延迟初始化，确保能获取到正确的初始dealerIndex
        let currentRotation = null;
        let previousDealerIndex = null;
        
        const dialRotation = computed(() => {
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
        
        // Watch for scale changes and update position offsets
        watch(globalScale, (newScale) => {
            // 使用 nextTick 确保 Vue 已经更新了 DOM
            nextTick(() => {
                updateCardPositionOffsets(newScale);
            });
        });
        
        const updateCardPositionOffsets = (scale) => {
            // 获取底部卡片(pos-0)来测量尺寸，因为它没有旋转
            const card = document.querySelector('.pos-0');
            if (!card) return;
            
            // 使用 requestAnimationFrame 确保浏览器已经应用了样式和缩放
            requestAnimationFrame(() => {
                // 再次使用 requestAnimationFrame 确保样式完全应用
                requestAnimationFrame(() => {
                    // 获取卡片的实际渲染尺寸（包含当前缩放）
                    const rect = card.getBoundingClientRect();
                    
                    // 从 DOM 读取实际应用的缩放值（Vue 已经通过 :style 设置了）
                    const appliedScale = parseFloat(getComputedStyle(card).getPropertyValue('--scale-factor')) || scale;
                    
                    // 计算原始尺寸（未缩放时）
                    const originalHeight = rect.height / appliedScale;
                    
                    // 计算偏移量：当从1放大到scale时，需要移动 size * (scale - 1) / 2
                    // pos-0和pos-2: 垂直方向使用原始height
                    // pos-1和pos-3: 旋转90度后，水平方向使用原始height (旋转前的垂直尺寸)
                    const offset = originalHeight * (appliedScale - 1) / 2;
                    
                    // 应用到所有玩家卡片
                    const cards = document.querySelectorAll('.player-card');
                    cards.forEach((c) => {
                        c.style.setProperty('--offset-x', `${offset}px`);
                        c.style.setProperty('--offset-y', `${offset}px`);
                    });
                });
            });
        };
        
        // Init
        onMounted(() => {
            loadState();
            initTheme();
            
            // 加载保存的缩放值，如果没有则自动计算
            const savedScale = localStorage.getItem('mj_scale');
            if (savedScale) {
                const scale = parseFloat(savedScale);
                // 确保缩放值在有效范围内
                if (scale >= 0.5 && scale <= absoluteMaxScale) {
                    globalScale.value = scale;
                } else {
                    // 如果保存的值无效，使用自动计算
                    nextTick(() => {
                        setTimeout(() => {
                            const optimalScale = calculateOptimalScale();
                            globalScale.value = optimalScale;
                            localStorage.setItem('mj_scale', optimalScale.toString());
                            // 更新按钮状态
                            const maxScale = calculateMaxScale();
                            canZoomIn.value = optimalScale < maxScale;
                            canZoomOut.value = optimalScale > 0.5;
                        }, 100);
                    });
                }
            } else {
                // 首次使用，自动计算合适的缩放比例
                nextTick(() => {
                    setTimeout(() => {
                        const optimalScale = calculateOptimalScale();
                        globalScale.value = optimalScale;
                        localStorage.setItem('mj_scale', optimalScale.toString());
                        
                        // 立即更新偏移量，确保初次加载时位置正确
                        updateCardPositionOffsets(optimalScale);
                        
                        // 更新按钮状态
                        const maxScale = calculateMaxScale();
                        canZoomIn.value = optimalScale < maxScale;
                        canZoomOut.value = optimalScale > 0.5;
                    }, 100);
                });
            }
            
            requestWakeLock();
            
            // 初始化位置偏移和按钮状态 - 使用多个 nextTick 和 setTimeout 确保 DOM 完全准备好
            nextTick(() => {
                // 等待 Vue 更新 DOM
                nextTick(() => {
                    // 再等待浏览器渲染
                    setTimeout(() => {
                        updateCardPositionOffsets(globalScale.value);
                        // 初始化按钮状态
                        const maxScale = calculateMaxScale();
                        canZoomIn.value = globalScale.value < maxScale;
                        canZoomOut.value = globalScale.value > 0.5;
                    }, 150);
                });
            });
            
            // 监听窗口大小变化和方向变化，重新计算偏移量和缩放限制
            const handleResize = () => {
                updateCardPositionOffsets(globalScale.value);
                // 重新计算缩放限制，更新按钮状态
                const maxScale = calculateMaxScale();
                canZoomIn.value = globalScale.value < maxScale;
                canZoomOut.value = globalScale.value > 0.5;
            };
            
            window.addEventListener('resize', handleResize);
            // 移除 orientationchange 监听
        });

        // Theme
        const toggleTheme = () => {
            isDark.value = !isDark.value;
            localStorage.setItem('mj_theme', isDark.value ? 'dark' : 'light');
            if (isDark.value) document.body.classList.add('dark');
            else document.body.classList.remove('dark');
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
            if (isDark.value) document.body.classList.add('dark');
        };

        // Data Persistence
        const saveState = () => {
            const state = {
                players: players.value,
                seats: seats.value,
                currentRound: currentRound.value,
                dealerIndex: dealerIndex.value,
                dealerStreak: dealerStreak.value,
                history: history.value
            };
            localStorage.setItem('mj_data_v3', JSON.stringify(state));
        };

        const loadState = () => {
            const saved = localStorage.getItem('mj_data_v3');
            if (saved) {
                const data = JSON.parse(saved);
                players.value = (data.players || []).map(p => ({
                    ...p,
                    origin: p.origin || 0 // 兼容旧数据，如果没有origin则设为0
                }));
                seats.value = data.seats || [null, null, null, null];
                currentRound.value = data.currentRound || 1;
                dealerIndex.value = data.dealerIndex || 0;
                dealerStreak.value = data.dealerStreak || 0;
                history.value = data.history || [];
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

        const handleSeatClick = (index) => {
            // Don't open seat modal if we just finished dragging
            if (dragState.value.dragging) return;
            
            activeSeatIndex.value = index;
            modals.value.seat = true;
        };

        const addNewPlayer = () => {
            const name = newPlayerName.value.trim();
            if (!name) return;
            if (players.value.some(p => p.name === name)) return alert('玩家已存在');
            players.value.push({ name, score: 0, origin: 0 });
            newPlayerName.value = '';
            saveState();
        };

        const sitDown = (name) => {
            seats.value[activeSeatIndex.value] = name;
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
        });

        const undo = () => {
            if (history.value.length === 0) return;
            if (!confirm('确定撤销上一次结算？')) return;

            const last = history.value.shift();
            last.transactions.forEach(t => {
                const fromP = players.value.find(p => p.name === t.from);
                const toP = players.value.find(p => p.name === t.to);
                if (fromP) fromP.score += t.amount;
                if (toP) toP.score -= t.amount;
            });
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
            const card = element?.closest('.player-card');
            
            if (card) {
                // Find the index of this card among all player cards
                const allCards = document.querySelectorAll('.player-card');
                const cardIndex = Array.from(allCards).indexOf(card);
                
                if (cardIndex !== -1 && cardIndex !== dragState.value.fromIndex) {
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
                // Reset drag state
                handleDragEnd();
            }
        };

        // Quick Settle Modal
        const openQuickSettle = (from, to) => {
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
            dealerIndex.value = (dealerIndex.value + 1) % 4;
            dealerStreak.value = 0;
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
                localStorage.removeItem('mj_data_v3');
                localStorage.removeItem('mj_scale'); // Clear saved scale
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
                                color: isDark.value ? '#fff' : '#333',
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
                        x: { ticks: { color: isDark.value ? '#aaa' : '#666' }, grid: { color: isDark.value ? '#333' : '#ddd' } },
                        y: { 
                            ticks: { 
                                color: isDark.value ? '#aaa' : '#666',
                                // 只显示整数，不显示小数
                                callback: function(value) {
                                    if (Math.floor(value) === value) {
                                        return value;
                                    }
                                }
                            }, 
                            grid: { color: isDark.value ? '#333' : '#ddd' } 
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
            modals, closeModal,
            activePlayers, availablePlayers, dialRotation,
            getPlayerScore, getPlayerCurrentScore, handleSeatClick, addNewPlayer, sitDown, newPlayerName,
            openSettleModal, settleFrom, settleTo, settleAmount, selectingFrom, isSelecting, errorFrom, errorTo, selectSettlePlayer, confirmSettle, amountInput, handleSelectBoxClick,
            appendNumber, backspaceNumber,
            undo, handleNextRoundClick, nextRoundCheck, nextRound,
            formatTime, clearData,
            showStats, showHistory: () => modals.value.history = true, showSettings: () => modals.value.settings = true, showRoundModal: () => {},
            showHelp: () => modals.value.help = true,
            showOriginSet, updateOrigin, setOriginToZero,
            // Zoom
            adjustScale, globalScale, canZoomIn, canZoomOut,
            // Drag and Drop (Player Cards)
            dragState,
            handleDragStart, handleDragEnd, handleDragOver, handleDragLeave, handleDrop,
            handleTouchStart, handleTouchMove, handleTouchEnd,
            // Drag and Drop (Next Round Button)
            handleNextRoundDragStart, handleNextRoundDragEnd,
            handleNextRoundTouchStart, handleNextRoundTouchMove, handleNextRoundTouchEnd,
            
            // Dice
            diceMode, isRolling, hasRolled, diceStyles, handleDialClick, closeDiceMode
        };
    }
}).mount('#app');

