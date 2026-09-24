import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import DashboardPage from './routes/DashboardPage.js';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
      </Routes>
    </BrowserRouter>
  );
}
