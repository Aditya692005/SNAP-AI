import AppRoutes from "./routes/AppRoutes";
import UserMenu from "./components/UserMenu";
import SessionWatcher from "./components/SessionWatcher";

function App() {
  return (
    <>
      <SessionWatcher />
      <AppRoutes />
      <UserMenu />
    </>
  );
}

export default App;
