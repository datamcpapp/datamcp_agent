# Quick Start Guide

## 🚀 Быстрый старт за 5 минут

### Шаг 1: Получите API ключ

1. Откройте https://datamcp.com/agents
2. Нажмите "Create Agent"
3. Скопируйте API ключ (начинается с `agent_`)

### Шаг 2: Запустите агент

#### Вариант A: Docker Compose (Рекомендуется)

```bash
# Создайте .env файл
cat > .env << EOF
DATAMCP_API_KEY=agent_ваш_ключ_здесь
AGENT_NAME=My Agent
EOF

# Запустите
docker-compose up -d

# Проверьте логи
docker-compose logs -f
```

#### Вариант B: Docker

```bash
docker run -d \
  --name datamcp-agent \
  --restart unless-stopped \
  -e DATAMCP_API_KEY=agent_ваш_ключ_здесь \
  -e AGENT_NAME="My Agent" \
  datamcp/agent:latest
```

#### Вариант C: Kubernetes

```bash
# Создайте secret с API ключом
kubectl create secret generic datamcp-agent-secret \
  --from-literal=api-key=agent_ваш_ключ_здесь

# Разверните агент
kubectl apply -f k8s/deployment.yaml

# Проверьте статус
kubectl get pods -l app=datamcp-agent
```

### Шаг 3: Проверьте работу

```bash
# Проверьте health
curl http://localhost:3000/health

# Проверьте подключение к Cloud
curl http://localhost:3000/ready
```

Ответ должен быть:
```json
{
  "status": "ready",
  "connected": true,
  "agentId": "agent_xxx",
  "timestamp": "2024-01-22T10:30:00.000Z"
}
```

### Шаг 4: Подключите базу данных

1. Откройте DataMCP Dashboard
2. Перейдите в "Connections"
3. Нажмите "Add Connection"
4. Выберите ваш агент
5. Введите данные подключения к БД
6. Нажмите "Test Connection"
7. Сохраните

### ✅ Готово!

Теперь вы можете:
- Выполнять запросы к БД через DataMCP
- Извлекать схему БД автоматически
- Использовать MCP интеграцию с AI инструментами
- Мониторить статус агента в реальном времени

## 📚 Дополнительная информация

- **Полная документация**: `README.md`
- **Публикация в Docker Hub**: `DOCKER_PUBLISHING.md`
- **Детали реализации**: `AGENT_COMPLETE.md`

## 🆘 Проблемы?

### Агент не подключается

```bash
# Проверьте логи
docker-compose logs datamcp-agent

# Проверьте API ключ
echo $DATAMCP_API_KEY

# Проверьте сетевое подключение
curl -I https://api.datamcp.com
```

### База данных недоступна

```bash
# Проверьте, что агент в той же сети что и БД
docker network ls

# Проверьте подключение к БД
psql -h localhost -U postgres -d mydb
```

### Высокое использование памяти

```bash
# Проверьте ресурсы
docker stats datamcp-agent

# Установите лимиты в docker-compose.yml
deploy:
  resources:
    limits:
      memory: 256M
```

## 💡 Советы

1. **Используйте осмысленные имена** для агентов (AGENT_NAME)
2. **Храните API ключи в secrets**, не в коде
3. **Мониторьте логи** для отладки проблем
4. **Используйте health checks** для автоматического перезапуска
5. **Обновляйте образ** регулярно: `docker pull datamcp/agent:latest`
