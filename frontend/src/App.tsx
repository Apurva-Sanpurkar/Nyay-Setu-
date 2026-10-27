import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import { ROLE_HOME } from "./lib/format";
import type { Role } from "./lib/api";
import { PortalShell } from "./components/PortalShell";
import { ApiUnreachable } from "./components/ApiUnreachable";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LinkButton, Spinner } from "./components/ui";
import { LogoMark } from "./components/Logo";

import Landing from "./pages/Landing";
import Login from "./pages/Login";

/**
 * Portal pages load on demand: a citizen checking in never downloads the
 * laboratory or registry screens. The landing and sign-in pages stay in the
 * main bundle so the first paint needs one request.
 */
function lazyNamed<M extends Record<string, unknown>, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(async () => ({ default: (await load())[name] as React.ComponentType<any> }));
}

const FirstRun = lazy(() => import("./pages/FirstRun"));
const Handbook = lazy(() => import("./pages/Handbook"));
const About = lazy(() => import("./pages/About"));
const VerifyPage = lazy(() => import("./pages/Verify"));
const CaseDossierPage = lazyNamed(() => import("./pages/shared"), "CaseDossierPage");
const CasesPage = lazyNamed(() => import("./pages/shared"), "CasesPage");
const EvidenceDetailPage = lazyNamed(() => import("./pages/shared"), "EvidenceDetailPage");
const NewCasePage = lazyNamed(() => import("./pages/police"), "NewCasePage");
const PoliceDashboard = lazyNamed(() => import("./pages/police"), "PoliceDashboard");
const CapturePage = lazyNamed(() => import("./pages/capture"), "CapturePage");
const ForensicInbox = lazyNamed(() => import("./pages/forensic"), "ForensicInbox");
const ProsecutorDashboard = lazyNamed(() => import("./pages/prosecutor"), "ProsecutorDashboard");
const BailBoard = lazyNamed(() => import("./pages/judge"), "BailBoard");
const JudgeDashboard = lazyNamed(() => import("./pages/judge"), "JudgeDashboard");
const SummonsPage = lazyNamed(() => import("./pages/judge"), "SummonsPage");
const DefenceVerify = lazyNamed(() => import("./pages/defence"), "DefenceVerify");
const AccusedCheckIn = lazyNamed(() => import("./pages/accused"), "AccusedCheckIn");
const AccusedHome = lazyNamed(() => import("./pages/accused"), "AccusedHome");
const AccusedSummons = lazyNamed(() => import("./pages/accused"), "AccusedSummons");
const AdminAccess = lazyNamed(() => import("./pages/admin"), "AdminAccess");
const AdminAudit = lazyNamed(() => import("./pages/admin"), "AdminAudit");
const AdminChain = lazyNamed(() => import("./pages/admin"), "AdminChain");
const AdminOverview = lazyNamed(() => import("./pages/admin"), "AdminOverview");
const AdminUsers = lazyNamed(() => import("./pages/admin"), "AdminUsers");
const AlertsPage = lazyNamed(() => import("./pages/alerts"), "AlertsPage");
const MalkhanaPage = lazyNamed(() => import("./pages/policeWorkflow"), "MalkhanaPage");
const SeizuresPage = lazyNamed(() => import("./pages/policeWorkflow"), "SeizuresPage");
const AccessRequestsPage = lazyNamed(() => import("./pages/court"), "AccessRequestsPage");
const AccusedHelpPage = lazyNamed(() => import("./pages/court"), "AccusedHelpPage");
const ApprovalsPage = lazyNamed(() => import("./pages/court"), "ApprovalsPage");
const HearingsPage = lazyNamed(() => import("./pages/court"), "HearingsPage");
const TemplatesPage = lazyNamed(() => import("./pages/templates"), "TemplatesPage");
const VehicleTracePage = lazyNamed(() => import("./pages/vehicleTrace"), "VehicleTracePage");
const VehicleReportPage = lazyNamed(() => import("./pages/vehicleTrace"), "VehicleReportPage");
const ThirdEyePage = lazyNamed(() => import("./pages/thirdEye"), "ThirdEyePage");
const PersonRecordPage = lazyNamed(() => import("./pages/thirdEye"), "PersonRecordPage");
const StationAlertsPage = lazyNamed(() => import("./pages/smartPolicing"), "StationAlertsPage");
const SmartAnalyticsPage = lazyNamed(() => import("./pages/smartPolicing"), "SmartAnalyticsPage");

/**
 * Routing.
 *
 * Each portal is gated twice: the route only renders for the right role, and
 * the API refuses anything the role is not entitled to. Neither gate is the
 * security boundary on its own, and the client one is purely so a user never
 * sees a screen that would only produce 403s.
 */

function FullPageSpinner() {
  return (
    <div className="grid min-h-screen place-items-center bg-bg">
      <div className="flex flex-col items-center gap-4">
        <LogoMark size={52} glow className="animate-float-y" />
        <Spinner />
        <p className="font-ui text-xs text-muted">Restoring your session…</p>
      </div>
    </div>
  );
}

function PageSpinner() {
  return (
    <div className="grid min-h-[40vh] place-items-center">
      <Spinner />
    </div>
  );
}

/** Requires a session, and optionally a specific set of roles. */
function Guard({ roles, children }: { roles?: Role[]; children: React.ReactNode }) {
  const { user, loading, unreachable, refresh } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageSpinner />;

  // Before deciding there is no session: there may be no API. Redirecting to
  // sign-in here would send somebody to a form that cannot work either, and the
  // reason would only be visible in a browser console.
  if (unreachable) {
    return <ApiUnreachable message={unreachable} onRetry={() => void refresh()} />;
  }

  if (!user) {
    // Remember where they were headed so sign-in can return them there.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  // An invited account has one destination until it has replaced the password it
  // was emailed. The API enforces this too; without the redirect the user would
  // just watch every panel fail with a 403 and no explanation.
  if (user.mustChangePassword) {
    return <Navigate to="/first-run" replace />;
  }

  if (roles && !roles.includes(user.role)) {
    // Not an error: send them to their own portal rather than a dead end.
    return <Navigate to={ROLE_HOME[user.role]} replace />;
  }

  return (
    <PortalShell>
      <ErrorBoundary resetKey={location.pathname}>
        <Suspense fallback={<PageSpinner />}>{children}</Suspense>
      </ErrorBoundary>
    </PortalShell>
  );
}

function NotFound() {
  const { user } = useAuth();
  return (
    <div className="grid min-h-screen place-items-center bg-bg px-5">
      <div className="max-w-md text-center">
        <p className="font-jakarta text-2xs font-bold uppercase tracking-[0.16em] text-primary">404</p>
        <h1 className="mt-2 font-display text-3xl leading-tight text-text">
          There is nothing at this address
        </h1>
        <p className="mt-3 font-ui text-sm leading-relaxed text-muted">
          The link may be stale, or the page may belong to a role other than yours.
        </p>
        <LinkButton to={user ? ROLE_HOME[user.role] : "/"} className="mt-6">
          {user ? "Back to your portal" : "Back to the start"}
        </LinkButton>
      </div>
    </div>
  );
}

/**
 * The case and evidence screens are identical for every role; what differs is
 * what the API returns. So one generator builds the three routes each portal
 * needs, rather than six copies drifting apart.
 */
function caseRoutes(basePath: string, roles: Role[]) {
  return [
    <Route
      key={`${basePath}-cases`}
      path={`${basePath}/cases`}
      element={
        <Guard roles={roles}>
          <CasesPage basePath={`${basePath}/cases`} />
        </Guard>
      }
    />,
    <Route
      key={`${basePath}-evidence`}
      path={`${basePath}/cases/evidence/:evidenceId`}
      element={
        <Guard roles={roles}>
          <EvidenceDetailPage />
        </Guard>
      }
    />,
    <Route
      key={`${basePath}-case`}
      path={`${basePath}/cases/:caseId`}
      element={
        <Guard roles={roles}>
          <CaseDossierPage basePath={`${basePath}/cases`} />
        </Guard>
      }
    />,
  ];
}

/**
 * Workflow pages added in 2.0. Each portal's navigation (PortalShell) links
 * to these paths; keeping them in one table makes a missing route easy to spot.
 */
const WORKFLOW_PAGES: { path: string; roles: Role[]; element: React.ReactNode }[] = [
  { path: "/police/seizures", roles: ["police"], element: <SeizuresPage /> },
  { path: "/police/malkhana", roles: ["police"], element: <MalkhanaPage /> },
  { path: "/police/alerts", roles: ["police"], element: <AlertsPage /> },
  // Smart policing (014): Vehicle Trace, Third Eye, inter-station alerts.
  { path: "/police/vehicles", roles: ["police"], element: <VehicleTracePage /> },
  { path: "/police/vehicles/:id", roles: ["police"], element: <VehicleReportPage /> },
  { path: "/police/third-eye", roles: ["police"], element: <ThirdEyePage /> },
  { path: "/police/third-eye/:id", roles: ["police"], element: <PersonRecordPage /> },
  { path: "/police/station-alerts", roles: ["police"], element: <StationAlertsPage /> },
  { path: "/police/analytics", roles: ["police"], element: <SmartAnalyticsPage /> },
  { path: "/admin/smart-policing", roles: ["court_admin"], element: <SmartAnalyticsPage /> },
  { path: "/prosecutor/alerts", roles: ["prosecutor"], element: <AlertsPage /> },
  { path: "/judge/alerts", roles: ["judge"], element: <AlertsPage /> },
  { path: "/admin/alerts", roles: ["court_admin"], element: <AlertsPage /> },
  { path: "/judge/hearings", roles: ["judge"], element: <HearingsPage /> },
  { path: "/judge/access", roles: ["judge"], element: <AccessRequestsPage /> },
  { path: "/judge/approvals", roles: ["judge"], element: <ApprovalsPage /> },
  { path: "/defence/access", roles: ["defence_lawyer"], element: <AccessRequestsPage /> },
  { path: "/admin/approvals", roles: ["court_admin"], element: <ApprovalsPage /> },
  { path: "/admin/templates", roles: ["court_admin"], element: <TemplatesPage /> },
  { path: "/accused/help", roles: ["accused"], element: <AccusedHelpPage /> },
];

export default function App() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <Routes>
        {WORKFLOW_PAGES.map((p) => (
          <Route
            key={p.path}
            path={p.path}
            element={
              <Guard roles={p.roles}>
                {p.element}
              </Guard>
            }
          />
        ))}

        {/* ------------------------------------------------------- public */}
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        {/* Public on purpose: a defence lawyer or an accused person needs to
            understand what the system claims about them before they have an
            account, and putting this behind a sign-in would defeat that. */}
        <Route path="/handbook" element={<Handbook />} />
        <Route path="/about" element={<About />} />
        {/* The Evidence Integrity Passport: public, no sign-in, no case data. */}
        <Route path="/verify" element={<VerifyPage />} />
        <Route path="/verify/:ref" element={<VerifyPage />} />
        {/* Signed in, but not through the gate: deliberately outside Guard, which
            would bounce it straight back here. */}
        <Route path="/first-run" element={<FirstRun />} />

        {/* -------------------------------------------------------- police */}
        <Route
          path="/police"
          element={
            <Guard roles={["police"]}>
              <PoliceDashboard />
            </Guard>
          }
        />
        <Route
          path="/police/capture"
          element={
            <Guard roles={["police"]}>
              <CapturePage />
            </Guard>
          }
        />
        <Route
          path="/police/new-case"
          element={
            <Guard roles={["police"]}>
              <NewCasePage />
            </Guard>
          }
        />
        {caseRoutes("/police", ["police"])}

        {/* ------------------------------------------------------ forensic */}
        <Route
          path="/forensic"
          element={
            <Guard roles={["forensic_lab"]}>
              <ForensicInbox />
            </Guard>
          }
        />
        <Route
          path="/forensic/capture"
          element={
            <Guard roles={["forensic_lab"]}>
              <CapturePage />
            </Guard>
          }
        />
        {caseRoutes("/forensic", ["forensic_lab"])}

        {/* ---------------------------------------------------- prosecutor */}
        <Route
          path="/prosecutor"
          element={
            <Guard roles={["prosecutor"]}>
              <ProsecutorDashboard />
            </Guard>
          }
        />
        {caseRoutes("/prosecutor", ["prosecutor"])}

        {/* --------------------------------------------------------- judge */}
        <Route
          path="/judge"
          element={
            <Guard roles={["judge"]}>
              <JudgeDashboard />
            </Guard>
          }
        />
        <Route
          path="/judge/summons"
          element={
            <Guard roles={["judge"]}>
              <SummonsPage />
            </Guard>
          }
        />
        <Route
          path="/judge/bail"
          element={
            <Guard roles={["judge"]}>
              <BailBoard />
            </Guard>
          }
        />
        {caseRoutes("/judge", ["judge"])}

        {/* ------------------------------------------------------- defence */}
        <Route
          path="/defence"
          element={
            <Guard roles={["defence_lawyer"]}>
              <DefenceVerify />
            </Guard>
          }
        />
        {caseRoutes("/defence", ["defence_lawyer"])}

        {/* ------------------------------------------------------- accused */}
        <Route
          path="/accused"
          element={
            <Guard roles={["accused"]}>
              <AccusedHome />
            </Guard>
          }
        />
        <Route
          path="/accused/summons"
          element={
            <Guard roles={["accused"]}>
              <AccusedSummons />
            </Guard>
          }
        />
        <Route
          path="/accused/checkin"
          element={
            <Guard roles={["accused"]}>
              <AccusedCheckIn />
            </Guard>
          }
        />

        {/* --------------------------------------------------- court admin */}
        <Route
          path="/admin"
          element={
            <Guard roles={["court_admin"]}>
              <AdminOverview />
            </Guard>
          }
        />
        <Route
          path="/admin/users"
          element={
            <Guard roles={["court_admin"]}>
              <AdminUsers />
            </Guard>
          }
        />
        <Route
          path="/admin/access"
          element={
            <Guard roles={["court_admin"]}>
              <AdminAccess />
            </Guard>
          }
        />
        <Route
          path="/admin/audit"
          element={
            <Guard roles={["court_admin"]}>
              <AdminAudit />
            </Guard>
          }
        />
        <Route
          path="/admin/chain"
          element={
            <Guard roles={["court_admin"]}>
              <AdminChain />
            </Guard>
          }
        />
        {caseRoutes("/admin", ["court_admin"])}

        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
