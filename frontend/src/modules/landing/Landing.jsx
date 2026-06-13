import { useNavigate } from "react-router-dom";
import "./Landing.css";

function Landing() {
  const navigate = useNavigate();

  return (
    <div className="Landing">
      <div className="content">
        <h1>SNAP AI</h1>

        <h2>
          Lorem ipsum dolor sit amet consectetur adipisicing elit. Praesentium
          doloremque quisquam in quo ab placeat suscipit incidunt aperiam ullam
          error dicta, vel numquam enim molestiae non aut beatae debitis eius!e.
        </h2>

        <div className="buttons">
          <button onClick={() => navigate("/signup")}>Sign Up</button>

          <button onClick={() => navigate("/login")}>Log In</button>
        </div>
      </div>
    </div>
  );
}

export default Landing;
