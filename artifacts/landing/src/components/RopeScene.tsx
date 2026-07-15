import React, { useEffect, useRef, useState } from 'react';
import { RefreshCcw } from 'lucide-react';
import auraLogo from '@/assets/aura-logo.png';
import floorImage from '@/assets/floor.png';

const SEGMENT_COUNT = 14;
const SEGMENT_LENGTH = 20;

const PLUG_HEIGHT = 74;
const PLUG_WIDTH = 44;
const SOCKET_OUTER_SIZE = 100;
const SOCKET_SQUISH = 0.52; // flattens the socket into a top-down ellipse
const SNAP_DURATION = 150; // ms -- fast, direct snap (120-180ms range)

// Docking point: the plug's attach point (top-center, where the cable meets
// the plug head) when fully seated. Chosen so the plug's bottom edge
// overlaps the socket's visual top surface with zero gap, and the (now
// hidden) prongs read as inserted into the socket center.
const DOCK_OFFSET_Y = -(PLUG_HEIGHT - (SOCKET_OUTER_SIZE * SOCKET_SQUISH) / 2 - 6);

// Ease-out-cubic: fast, direct, monotonic approach -- no overshoot, no hop.
function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

class Point {
  x: number;
  y: number;
  oldX: number;
  oldY: number;
  pinned: boolean;

  constructor(x: number, y: number, pinned = false) {
    this.x = x;
    this.y = y;
    this.oldX = x;
    this.oldY = y;
    this.pinned = pinned;
  }
}

class Spring {
  p1: Point;
  p2: Point;
  length: number;
  stiffness: number;

  constructor(p1: Point, p2: Point, length: number, stiffness = 0.6) {
    this.p1 = p1;
    this.p2 = p2;
    this.length = length;
    this.stiffness = stiffness;
  }

  update() {
    const dx = this.p2.x - this.p1.x;
    const dy = this.p2.y - this.p1.y;
    const dist = Math.hypot(dx, dy) || 1;
    const diff = this.length - dist;
    const percent = (diff / dist) * this.stiffness;
    const offsetX = dx * percent;
    const offsetY = dy * percent;

    if (!this.p1.pinned) {
      this.p1.x -= offsetX;
      this.p1.y -= offsetY;
    }
    if (!this.p2.pinned) {
      this.p2.x += offsetX;
      this.p2.y += offsetY;
    }
  }
}

export default function RopeScene() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [connected, setConnected] = useState(false);
  const [showText, setShowText] = useState(false);
  const [justSnapped, setJustSnapped] = useState(false);

  const pointsRef = useRef<Point[]>([]);
  const springsRef = useRef<Spring[]>([]);
  
  const isDragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const mouseRef = useRef({ x: 0, y: 0 });
  
  const socketPos = useRef({ x: 0, y: 0 });
  const timeRef = useRef(0);
  const connectedRef = useRef(false);
  const dockedRef = useRef(false); // true once the snap tween has fully completed and locked
  const snapStartRef = useRef<{ t: number; x: number; y: number; angle: number } | null>(null);

  const [plugRender, setPlugRender] = useState({ x: 0, y: 0, angle: Math.PI / 2 });
  const [socketState, setSocketState] = useState({ x: 0, y: 0 });

  useEffect(() => {
    document.title = "AURA | Live the Experience";
    const meta = document.createElement('meta');
    meta.name = "description";
    meta.content = "AURA is a premium smart-home connected device. Coming soon.";
    document.head.appendChild(meta);
  }, []);

  const initSimulation = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    if (canvasRef.current) {
      canvasRef.current.width = width;
      canvasRef.current.height = height;
    }
    
    const anchorX = width / 2;
    const anchorY = -20;

    socketPos.current = { x: width / 2, y: height * 0.75 };
    setSocketState(socketPos.current);

    const pts: Point[] = [];
    const sps: Spring[] = [];

    for (let i = 0; i < SEGMENT_COUNT; i++) {
      pts.push(new Point(anchorX, anchorY + i * SEGMENT_LENGTH, i === 0));
    }
    
    for (let i = 0; i < SEGMENT_COUNT - 1; i++) {
      sps.push(new Spring(pts[i], pts[i + 1], SEGMENT_LENGTH, 0.6));
    }

    pointsRef.current = pts;
    springsRef.current = sps;
  };

  useEffect(() => {
    initSimulation();

    const handleResize = () => {
      // Just update socket position and canvas size, don't reset rope completely
      const width = window.innerWidth;
      const height = window.innerHeight;
      if (canvasRef.current) {
        canvasRef.current.width = width;
        canvasRef.current.height = height;
      }
      socketPos.current = { x: width / 2, y: height * 0.75 };
      setSocketState(socketPos.current);
      
      if (pointsRef.current.length > 0) {
        pointsRef.current[0].x = width / 2; // update anchor
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    let animId: number;

    const loop = () => {
      timeRef.current += 0.05;
      const pts = pointsRef.current;
      const sps = springsRef.current;
      const width = window.innerWidth;
      const anchorX = width / 2;
      const anchorY = -20;

      // Update points
      pts.forEach((p, i) => {
        if (p.pinned) return;

        // Friction
        const vx = (p.x - p.oldX) * 0.94;
        const vy = (p.y - p.oldY) * 0.94;

        p.oldX = p.x;
        p.oldY = p.y;

        p.x += vx;
        p.y += vy;

        // Self-straightening pull
        const restX = anchorX;
        const restY = anchorY + i * SEGMENT_LENGTH;
        p.x += (restX - p.x) * 0.03;
        p.y += (restY - p.y) * 0.03;

        // Gentle floating sway when idle. Once docked, the plug itself must
        // stay perfectly still -- only the cable segments above it may show
        // a very subtle elastic settle motion.
        const isPlugPoint = i === pts.length - 1;
        if (!isDragging.current && !(isPlugPoint && connectedRef.current)) {
          const amp = connectedRef.current ? 0.08 : 1; // subtle settle once connected
          p.x += Math.sin(timeRef.current + i * 0.3) * 0.3 * amp;
          p.y += Math.cos(timeRef.current * 0.5 + i * 0.3) * 0.1 * amp;
        }
      });

      // Constraints
      if (pts.length > 0) {
        const lastPoint = pts[pts.length - 1];
        
        if (isDragging.current) {
          lastPoint.x = mouseRef.current.x;
          lastPoint.y = mouseRef.current.y;
          // dampen velocity while dragging
          lastPoint.oldX = lastPoint.x;
          lastPoint.oldY = lastPoint.y;
        } else if (connectedRef.current && !dockedRef.current) {
          const targetX = socketPos.current.x;
          const targetY = socketPos.current.y + DOCK_OFFSET_Y;

          const snap = snapStartRef.current;
          if (snap) {
            const elapsed = performance.now() - snap.t;
            const rawT = Math.min(elapsed / SNAP_DURATION, 1);
            const eased = easeOutCubic(rawT);

            lastPoint.x = snap.x + (targetX - snap.x) * eased;
            lastPoint.y = snap.y + (targetY - snap.y) * eased;

            if (rawT >= 1) {
              // Tween finished: hard-lock position and rotation exactly,
              // then fire a tiny one-shot impact pulse (not a hop/bounce --
              // it plays only after the plug has already arrived).
              lastPoint.x = targetX;
              lastPoint.y = targetY;
              lastPoint.pinned = true;
              dockedRef.current = true;
              setJustSnapped(true);
              setTimeout(() => setJustSnapped(false), 130);
            }
          } else {
            lastPoint.x = targetX;
            lastPoint.y = targetY;
            lastPoint.pinned = true;
            dockedRef.current = true;
            setJustSnapped(true);
            setTimeout(() => setJustSnapped(false), 130);
          }
          lastPoint.oldX = lastPoint.x;
          lastPoint.oldY = lastPoint.y;
        }

        // Resolve springs
        for (let iter = 0; iter < 5; iter++) {
          sps.forEach(s => s.update());
        }

        // Draw Canvas
        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Draw drop shadow
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length - 1; i++) {
              const p = pts[i];
              const nextP = pts[i + 1];
              const cx = (p.x + nextP.x) / 2;
              const cy = (p.y + nextP.y) / 2;
              ctx.quadraticCurveTo(p.x, p.y, cx, cy);
            }
            ctx.lineTo(lastPoint.x, lastPoint.y);
            ctx.strokeStyle = 'rgba(0,0,0,0.5)';
            ctx.lineWidth = 16;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.stroke();

            // Main matte black cable
            ctx.strokeStyle = '#151515';
            ctx.lineWidth = 10;
            ctx.stroke();

            // Subtle highlight
            ctx.beginPath();
            ctx.moveTo(pts[0].x - 1, pts[0].y);
            for (let i = 1; i < pts.length - 1; i++) {
              const p = pts[i];
              const nextP = pts[i + 1];
              const cx = (p.x + nextP.x) / 2;
              const cy = (p.y + nextP.y) / 2;
              ctx.quadraticCurveTo(p.x - 1, p.y, cx - 1, cy);
            }
            ctx.lineTo(lastPoint.x - 1, lastPoint.y);
            ctx.strokeStyle = '#282828';
            ctx.lineWidth = 2;
            ctx.stroke();
          }
        }

        // Sync HTML Plug
        if (pts.length >= 2) {
          const prev = pts[pts.length - 2];
          const naturalAngle = Math.atan2(lastPoint.y - prev.y, lastPoint.x - prev.x);

          if (connectedRef.current) {
            // Rotation snaps to point straight down so the prongs insert
            // directly downward into the socket's upward-facing holes.
            const DOWN = Math.PI / 2;
            const snap = snapStartRef.current;
            let angle = DOWN;
            if (snap && !dockedRef.current) {
              const elapsed = performance.now() - snap.t;
              const eased = easeOutCubic(Math.min(elapsed / SNAP_DURATION, 1));
              angle = snap.angle + (DOWN - snap.angle) * eased;
            }
            setPlugRender({ x: lastPoint.x, y: lastPoint.y, angle });
          } else {
            setPlugRender({ x: lastPoint.x, y: lastPoint.y, angle: naturalAngle });
          }
        }
      }

      animId = requestAnimationFrame(loop);
    };
    
    loop();
    return () => cancelAnimationFrame(animId);
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (connectedRef.current) return;
    const lastPoint = pointsRef.current[pointsRef.current.length - 1];
    if (!lastPoint) return;

    const angle = plugRender.angle;
    const plugCenterX = lastPoint.x + Math.cos(angle) * 37;
    const plugCenterY = lastPoint.y + Math.sin(angle) * 37;

    const dist = Math.hypot(e.clientX - plugCenterX, e.clientY - plugCenterY);

    if (dist < 80) { // generous grab radius
      isDragging.current = true;
      dragOffset.current = { x: lastPoint.x - e.clientX, y: lastPoint.y - e.clientY };
      if (containerRef.current) {
        containerRef.current.setPointerCapture(e.pointerId);
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current) return;
    mouseRef.current = {
      x: e.clientX + dragOffset.current.x,
      y: e.clientY + dragOffset.current.y
    };
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDragging.current) return;
    isDragging.current = false;
    
    if (containerRef.current) {
      containerRef.current.releasePointerCapture(e.pointerId);
    }

    const lastPoint = pointsRef.current[pointsRef.current.length - 1];
    if (!lastPoint) return;

    const angle = plugRender.angle;
    // Calculate tip of the prongs to match socket
    const prongsX = lastPoint.x + Math.cos(angle) * 70;
    const prongsY = lastPoint.y + Math.sin(angle) * 70;

    const socketX = socketPos.current.x;
    const socketY = socketPos.current.y;

    const dist = Math.hypot(prongsX - socketX, prongsY - socketY);

    // Magnetic snap zone
    if (dist < 80) {
      dockedRef.current = false;
      snapStartRef.current = {
        t: performance.now(),
        x: lastPoint.x,
        y: lastPoint.y,
        angle,
      };
      connectedRef.current = true;
      setConnected(true);
      setTimeout(() => setShowText(true), 600);
    }
  };

  const reset = () => {
    connectedRef.current = false;
    dockedRef.current = false;
    snapStartRef.current = null;
    setConnected(false);
    setShowText(false);

    // Unpin the plug point so physics/dragging resume normally.
    const last = pointsRef.current[pointsRef.current.length - 1];
    if (last) last.pinned = false;

    // Perturb for physical feedback
    pointsRef.current.forEach((p, i) => {
      if (!p.pinned) {
        p.x += (Math.random() - 0.5) * 80;
        p.y -= Math.random() * 60;
      }
    });
  };

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 concrete-bg select-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{ touchAction: 'none' }}
    >
      {/* Lighting Overlays */}
      <div
        className="absolute inset-0 transition-opacity duration-[1500ms] pointer-events-none"
        style={{
          opacity: connected ? 1 : 0,
          background: 'radial-gradient(circle at 50% 75%, rgba(245, 201, 122, 0.25) 0%, rgba(255, 184, 77, 0.08) 40%, rgba(0,0,0,0) 80%)'
        }}
      />
      <div
        className="absolute inset-0 transition-opacity duration-[2500ms] delay-300 pointer-events-none"
        style={{
          opacity: connected ? 1 : 0,
          background: 'radial-gradient(circle at 50% 85%, rgba(245, 201, 122, 0.15) 0%, transparent 60%)'
        }}
      />

      {/* Floor plane -- real concrete floor photo, the socket sits embedded
          in it, blended into the dark void above via a fade mask */}
      <div
        className="absolute inset-x-0 bottom-0 pointer-events-none z-0"
        style={{
          top: '50%',
          backgroundImage: `url(${floorImage})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center bottom',
          opacity: 0.5,
          filter: 'brightness(1.5) contrast(1.02) blur(1.5px)',
          maskImage: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.15) 14%, rgba(0,0,0,0.5) 22%, rgba(0,0,0,0.85) 30%, rgba(0,0,0,1) 40%)',
          WebkitMaskImage: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.15) 14%, rgba(0,0,0,0.5) 22%, rgba(0,0,0,0.85) 30%, rgba(0,0,0,1) 40%)',
        }}
      />

      <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none z-10" />

      {/* Socket -- a flat disc embedded in the ground, viewed from a slight
          elevation. The whole assembly is squished vertically (scaleY) so
          its plane reads as parallel to the floor with holes facing
          straight up toward the hanging plug, not tilted toward camera. */}
      <div
        className="absolute z-0 pointer-events-none"
        style={{
          left: socketState.x - SOCKET_OUTER_SIZE / 2,
          top: socketState.y - (SOCKET_OUTER_SIZE * SOCKET_SQUISH) / 2,
          width: SOCKET_OUTER_SIZE,
          height: SOCKET_OUTER_SIZE * SOCKET_SQUISH,
        }}
      >
        {/* Ground contact shadow, drawn flat (not squished) beneath the disc */}
        <div
          className="absolute left-1/2 -translate-x-1/2 rounded-full"
          style={{
            bottom: -6,
            width: SOCKET_OUTER_SIZE * 0.9,
            height: 18,
            background: 'radial-gradient(ellipse, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0) 75%)',
          }}
        />
        <div
          className="absolute inset-0 rounded-full flex items-center justify-center"
          style={{
            background: 'linear-gradient(180deg, #3a3a3a 0%, #161616 55%, #050505 100%)',
            boxShadow: '0 6px 14px rgba(0,0,0,0.9), inset 0 1.5px 2px rgba(255,255,255,0.12), inset 0 -3px 6px rgba(0,0,0,0.85)',
          }}
        >
          <div
            className="rounded-full flex flex-col items-center justify-center gap-1.5 relative overflow-hidden"
            style={{
              width: '64%',
              height: '64%',
              background: '#0a0a0a',
              boxShadow: 'inset 0 4px 8px rgba(0,0,0,1), inset 0 0 5px rgba(0,0,0,0.9), 0 1px 1px rgba(255,255,255,0.1)',
            }}
          >
            {/* Prong holes face straight up toward the plug */}
            <div className="flex gap-[14px]" style={{ transform: `scaleY(${1 / SOCKET_SQUISH})` }}>
              <div className="w-[6px] h-[10px] bg-[#020202] rounded-[2px] shadow-[inset_0_2px_4px_rgba(0,0,0,1)]" />
              <div className="w-[6px] h-[10px] bg-[#020202] rounded-[2px] shadow-[inset_0_2px_4px_rgba(0,0,0,1)]" />
            </div>
            <div
              className="w-[8px] h-[10px] bg-[#020202] rounded-[2px] mt-0.5 shadow-[inset_0_2px_4px_rgba(0,0,0,1)]"
              style={{ transform: `scaleY(${1 / SOCKET_SQUISH})` }}
            />

            <div
              className={`absolute inset-0 transition-opacity duration-1000 ${connected ? 'opacity-100' : 'opacity-0'}`}
              style={{
                background: 'radial-gradient(circle at 50% 50%, rgba(255, 184, 77, 0.7) 0%, rgba(245, 201, 122, 0) 70%)',
                mixBlendMode: 'screen',
              }}
            />
          </div>
        </div>
      </div>

      {/* Plug -- clean 3-prong power-plug head: a compact, slightly tapered
          matte body with horizontal grip ribs and 2 angled flat blades +
          1 round ground pin. No decorative side bulges. The outer element
          only ever carries position + rotation; the inner wrapper carries
          the one-shot squash/stretch impact pulse so it never fights the
          rotation transform. */}
      <div
        className={`absolute ${isDragging.current ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={{
          width: PLUG_WIDTH,
          height: PLUG_HEIGHT,
          left: plugRender.x - PLUG_WIDTH / 2,
          top: plugRender.y,
          transformOrigin: 'top center',
          transform: `rotate(${plugRender.angle - Math.PI / 2}rad)`,
          zIndex: 20,
        }}
      >
        <div
          className="w-full h-full flex flex-col items-center"
          style={{
            transform: justSnapped ? 'scale(1.05, 0.92)' : 'scale(1, 1)',
            transformOrigin: '50% 75%',
            transition: justSnapped ? 'transform 55ms ease-out' : 'transform 90ms ease-out',
          }}
        >
          {/* Body: rectangular, slightly tapered toward the bottom */}
          <div
            className="relative"
            style={{
              width: '100%',
              height: 50,
              background: 'linear-gradient(175deg, #262626 0%, #161616 55%, #0d0d0d 100%)',
              clipPath: 'polygon(8% 0%, 92% 0%, 100% 92%, 96% 100%, 4% 100%, 0% 92%)',
              boxShadow: '0 12px 28px rgba(0,0,0,0.75), inset 0 1.5px 3px rgba(255,255,255,0.09), inset 0 -3px 6px rgba(0,0,0,0.85)',
            }}
          >
            {/* Grip ribs -- horizontal ridges, no side ornamentation */}
            <div className="absolute inset-x-[15%] top-[18px] flex flex-col gap-[5px]">
              <div className="h-[2px] rounded-full" style={{ background: 'rgba(0,0,0,0.55)', boxShadow: '0 1px 0 rgba(255,255,255,0.04)' }} />
              <div className="h-[2px] rounded-full" style={{ background: 'rgba(0,0,0,0.55)', boxShadow: '0 1px 0 rgba(255,255,255,0.04)' }} />
              <div className="h-[2px] rounded-full" style={{ background: 'rgba(0,0,0,0.55)', boxShadow: '0 1px 0 rgba(255,255,255,0.04)' }} />
            </div>
          </div>

          {/* Prongs: 2 angled flat blades + 1 round ground pin. Once
              connected they are fully seated inside the socket and must not
              be visible at all -- retract AND fade out, don't just shift
              position (a partial retract still shows bare metal through
              the socket opening). */}
          <div
            className="relative flex items-start justify-center transition-all duration-150 ease-out"
            style={{
              width: 28,
              height: 18,
              marginTop: -2,
              transform: connected ? 'translateY(-20px) scale(0.85)' : 'translateY(0) scale(1)',
              opacity: connected ? 0 : 1,
            }}
          >
            <div
              className="absolute left-[3px] top-0 w-[4px] h-[16px] rounded-[1px]"
              style={{ background: 'linear-gradient(180deg, #9a9a9a 0%, #4c4c4c 100%)', transform: 'rotate(16deg)', transformOrigin: 'top center' }}
            />
            <div
              className="absolute right-[3px] top-0 w-[4px] h-[16px] rounded-[1px]"
              style={{ background: 'linear-gradient(180deg, #9a9a9a 0%, #4c4c4c 100%)', transform: 'rotate(-16deg)', transformOrigin: 'top center' }}
            />
            <div
              className="absolute left-1/2 -translate-x-1/2 top-[9px] w-[6px] h-[8px] rounded-full"
              style={{ background: 'radial-gradient(circle at 35% 30%, #a8a8a8 0%, #3a3a3a 75%)' }}
            />
          </div>
        </div>
      </div>

      {/* Logo -- fixed to the top of the screen, always part of the brand
          header, larger and independent of the connection reveal position */}
      <div className="absolute top-24 md:top-32 inset-x-0 flex justify-center z-30 pointer-events-none">
        {showText && (
          <div className="relative animate-in fade-in slide-in-from-top-4 duration-1000 fill-mode-both">
            <div className="absolute inset-0 bg-[#F5C97A] blur-[30px] opacity-40 rounded-full" />
            <img src={auraLogo} alt="AURA" className="h-12 md:h-16 lg:h-20 relative z-10 opacity-90 drop-shadow-[0_0_15px_rgba(245,201,122,0.8)]" />
          </div>
        )}
      </div>

      {/* Typography Reveal -- centered in the middle of the screen */}
      <div className="absolute inset-0 pointer-events-none z-30 flex items-center justify-center text-center">
        {showText && (
          <h1 className="font-serif text-[12vw] sm:text-[6rem] lg:text-[8rem] text-white tracking-[0.2em] font-normal leading-none drop-shadow-[0_0_20px_rgba(245,201,122,0.6)] animate-in fade-in slide-in-from-bottom-8 duration-[1500ms] fill-mode-both">
            COMING<br/>SOON
          </h1>
        )}
      </div>

      {/* Reset Control */}
      <div className={`absolute bottom-8 right-8 z-40 transition-opacity duration-1000 delay-1000 ${connected ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <button
          onClick={reset}
          className="text-neutral-500 hover:text-white transition-colors duration-300 text-xs tracking-[0.2em] flex items-center gap-2 font-light px-4 py-2 cursor-pointer"
        >
          RESET <RefreshCcw size={12} />
        </button>
      </div>
    </div>
  );
}
