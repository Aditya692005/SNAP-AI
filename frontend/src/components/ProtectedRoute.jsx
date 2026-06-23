import { Navigate } from 'react-router-dom'
import { authService } from '../services/authService'

const ProtectedRoute = ({ children }) => {
  console.log('isAuthenticated:', authService.isAuthenticated())
  
  if (!authService.isAuthenticated()) {
    return <Navigate to="/login" replace />
  }
  return children
}

export default ProtectedRoute