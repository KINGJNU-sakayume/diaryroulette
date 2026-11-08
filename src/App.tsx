import { lazy, Suspense, useEffect } from 'react'
import { HashRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { ThemeProvider } from './theme/ThemeProvider'
import Layout from './components/shared/Layout'
import Home from './pages/Home'
import Write from './pages/Write'
import Archive from './pages/Archive'
import Drafts from './pages/Drafts'
import Stats from './pages/Stats'
import { LifeHubAgent } from './components/LifeHub/LifeHub'
import BoardUploadAgent from './components/LifeHub/BoardUploadAgent'

// 개발 모드에서만 불러오는 점검 패널. 프로덕션 번들에는 들어가지 않는다.
const DevReviewPanel = import.meta.env.DEV ? lazy(() => import('./components/DevReviewPanel/DevReviewPanel')) : null

function LayoutOutlet() {
  return (
    <Layout>
      <Outlet />
    </Layout>
  )
}

/** 화면을 옮길 때마다 맨 위에서 시작 (기록의 날짜별 모달 열기/닫기는 제외) */
function ScrollToTop() {
  const { pathname } = useLocation()
  const section = pathname.split('/')[1]
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [section])
  return null
}

export default function App() {
  return (
    <ThemeProvider>
      <HashRouter>
        <ScrollToTop />
        <LifeHubAgent />
        <BoardUploadAgent />
        <Routes>
          <Route element={<LayoutOutlet />}>
            <Route index element={<Home />} />
            <Route path="archive" element={<Archive />}>
              {/* /archive/2026-09-28 — 해당 날짜의 일기를 바로 연다 */}
              <Route path=":date" element={null} />
            </Route>
            <Route path="drafts" element={<Drafts />} />
            <Route path="stats" element={<Stats />} />
          </Route>
          {/* 글 쓰는 화면은 탭바 없이 집중 모드로 */}
          <Route path="write" element={<Write />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>

        {DevReviewPanel && (
          <Suspense fallback={null}>
            <DevReviewPanel />
          </Suspense>
        )}
      </HashRouter>
    </ThemeProvider>
  )
}
