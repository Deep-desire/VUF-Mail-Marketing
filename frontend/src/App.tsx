import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import UploadExcel from './pages/UploadExcel';
import UploadDetails from './pages/UploadDetails';
import Templates from './pages/Templates';
import CreateTemplate from './pages/CreateTemplate';
import Unsubscribe from './pages/Unsubscribe';

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/unsubscribe/:token" element={<Unsubscribe />} />

      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/uploads/new" element={<UploadExcel />} />
        <Route path="/uploads/:id" element={<UploadDetails />} />
        <Route path="/templates" element={<Templates />} />
        <Route path="/templates/create" element={<CreateTemplate />} />
        <Route path="/templates/:id/edit" element={<CreateTemplate />} />
      </Route>

      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default App;
