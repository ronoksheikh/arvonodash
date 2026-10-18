import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { useAuth } from "./auth";
import { Layout } from "./components/Layout";
import { LoadingState } from "./components/ui";
import { LoginPage } from "./pages/Login";

const Overview = lazy(() => import("./pages/Overview"));
const Orders = lazy(() => import("./pages/Orders"));
const Consignments = lazy(() => import("./pages/Consignments"));
const PrintQueue = lazy(() => import("./pages/PrintQueue"));
const Dispatch = lazy(() => import("./pages/Dispatch"));
const Returns = lazy(() => import("./pages/Returns"));
const Customers = lazy(() => import("./pages/Customers"));
const Cod = lazy(() => import("./pages/Cod"));
const ActivityPage = lazy(() => import("./pages/Activity"));
const Sync = lazy(() => import("./pages/Sync"));
const SettingsPage = lazy(() => import("./pages/Settings"));
const Print = lazy(() => import("./pages/Print"));
const Scan = lazy(() => import("./pages/Scan"));
const Track = lazy(() => import("./pages/Track"));
const Pickup = lazy(() => import("./pages/Pickup"));
const Stuck = lazy(() => import("./pages/Stuck"));
const ReportPage = lazy(() => import("./pages/Report"));

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingState />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

export function App() {
  return (
    <Suspense fallback={<LoadingState />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* Public: customer order tracking */}
        <Route path="/t/:token" element={<Track />} />
        <Route path="/print" element={<RequireAuth><Print /></RequireAuth>} />
        <Route path="/scan" element={<RequireAuth><Scan /></RequireAuth>} />
        <Route element={<RequireAuth><Layout /></RequireAuth>}>
          <Route index element={<Overview />} />
          <Route path="orders" element={<Orders />} />
          <Route path="consignments" element={<Consignments />} />
          <Route path="print-queue" element={<PrintQueue />} />
          <Route path="dispatch" element={<Dispatch />} />
          <Route path="pickup" element={<Pickup />} />
          <Route path="stuck" element={<Stuck />} />
          <Route path="report" element={<ReportPage />} />
          <Route path="returns" element={<Returns />} />
          <Route path="customers" element={<Customers />} />
          <Route path="cod" element={<Cod />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route path="sync" element={<Sync />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
