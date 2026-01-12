import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import ProjectsPage from './pages/ProjectsPage';
import ProjectDetailPage from './pages/ProjectDetailPage';
import AgentsPage from './pages/AgentsPage';
import ShellPage from './pages/ShellPage';
import SettingsPage from './pages/SettingsPage';

function App() {
  return (
    <Routes>
      {/* Full-screen editor without Layout */}
      <Route path="/projects/:projectId" element={<ProjectDetailPage />} />

      {/* Pages with Layout */}
      <Route
        path="*"
        element={
          <Layout>
            <Routes>
              <Route path="/" element={<Navigate to="/projects" replace />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/agents" element={<AgentsPage />} />
              {/* Legacy routes redirect to new paths */}
              <Route path="/runs" element={<Navigate to="/projects" replace />} />
              <Route path="/runs/:runId" element={<Navigate to="/projects/:runId" replace />} />
              <Route path="/shell" element={<ShellPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </Layout>
        }
      />
    </Routes>
  );
}

export default App;
