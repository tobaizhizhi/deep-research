import { ResearchForm } from "@/components/research-form";
import { Icon } from "@/components/icon";

const steps = [
  {
    number: "01",
    icon: "compass",
    title: "明确研究方向",
    text: "从问题出发，拆解值得探索的主题。",
  },
  {
    number: "02",
    icon: "search",
    title: "寻找可靠依据",
    text: "检索来源，对照事实，识别信息缺口。",
  },
  {
    number: "03",
    icon: "document",
    title: "形成研究报告",
    text: "汇总发现，让结论与来源一起呈现。",
  },
] as const;

export default function HomePage() {
  return (
    <div className="page-enter">
      <section className="page-heading home-heading">
        <p className="eyebrow">
          <span /> A SPACE FOR INQUIRY
        </p>
        <h1>
          让每一个结论，
          <br className="mobile-break" />
          <em>都有据可循。</em>
        </h1>
        <p className="page-description">
          从一个好问题开始，深入资料，连接证据，形成自己的理解。
        </p>
      </section>
      <div className="research-layout">
        <ResearchForm />
        <aside className="research-aside" aria-label="研究说明">
          <div className="aside-heading">
            <span className="eyebrow">THE PROCESS</span>
            <h2>一次研究的旅程</h2>
          </div>
          <ol className="process-list">
            {steps.map((step) => (
              <li key={step.number}>
                <span className="process-icon">
                  <Icon name={step.icon} />
                </span>
                <div>
                  <span className="step-number">{step.number}</span>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="research-tip">
            <Icon name="link" size={18} />
            <div>
              <h3>让问题更具体一些</h3>
              <p>
                说明你想了解的对象、应用场景或时间范围，有助于找到更相关的资料。
              </p>
            </div>
          </div>
          <p className="availability-note">
            目前可确认需求、保存任务和管理排队。
            <br />
            研究执行与报告生成尚未开放。
          </p>
        </aside>
      </div>
    </div>
  );
}
