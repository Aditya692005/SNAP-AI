import AppRoutes from "./routes/AppRoutes";
import UserMenu from "./components/UserMenu";
import SessionWatcher from "./components/SessionWatcher";
import { UpdatesProvider } from "./context/UpdatesContext";

function App() {
  return (
    <UpdatesProvider>
      <SessionWatcher />
      <AppRoutes />
      <UserMenu />
    </UpdatesProvider>
  );
}

export default App;
